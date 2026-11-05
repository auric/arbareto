// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T222: `reviewSubmodules` and the `submoduleNotice` of `readWorkspace` (contract §12 "Discovery notice", "Review reads", "Plan", "Refusals", "Trust").
// `src/git-service/submodule-review.ts` and the notice of `src/git-service/status.ts` come with T229. T229 registers `reviewSubmodules`, and T230 registers `updateSubmodules`.

import { describe, expect, spyOn } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { APPROVAL_LIFETIME_MS, SUBMODULE_REVIEW_SUBMODULES, TRUST_INPUT_BYTES, UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION, WINDOWS_COMMAND_LINE_UNITS } from "../../src/contracts/limits";
import { submoduleConfigListArgs } from "../../src/git-service/commands";
import { redactUrlUserInfo, type SubmoduleAction, type SubmodulePlanRow } from "../../src/contracts/submodules";
import * as approvalsModule from "../../src/git-service/approvals";
import * as trustModule from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, removeTree, serviceEnv, useFixtureRoot } from "./fixture-root";
import { countPath, deepWorld, flatName, flatWorld, folderWorld } from "./submodule-count-fixture";
import { buildF27, buildF28, buildF29, F27_TOKEN_URL, put, type Built, type F27Variant, type F28Variant } from "./fixtures";
import { fileSha256, rawIndexDigest, refState, workingFileDigests } from "./git-oracle";
import { gitPath, outcome, readOk, SUCCEEDED, TIMEOUT_MS, until, valuesOf, withService } from "./hunk-harness";
import { caseTest, NO_TOTAL_DEADLINE_WAIT_MS, once, RESPONSE_WAIT_MS, withFsCalls, type Capability, type Service, type ServiceResponse } from "./service-harness";
import {
  actionsOf,
  callsSince,
  commandOf,
  copySuper,
  fixtureGit,
  gitLocation,
  globalEnv,
  insideSubmodule,
  invalidGitFolder,
  isReviewRead,
  isTrackCall,
  moduleDirOf,
  NOTES,
  objectsWith,
  oracleOf,
  ranCanaries,
  resultsOf,
  reviewSubmodules,
  refusalsOf,
  rowOf,
  saveCommand,
  sendUpdate,
  shortUpstream,
  statusBranchMark,
  submoduleCalls,
  superOf,
  TEXTS,
  treeGit,
  treeWorld,
  underTestSubmodule,
  UPDATE_TEXT,
  updateCommand,
  updateSteps,
  updateSubmodules,
  withFixture,
  type SubmoduleRefusal,
  type SubmoduleReview,
  type TreeWorld,
} from "./submodule-harness";

printOrigin("../../src/contracts/submodules.ts", import.meta.dir);

const TASK = "T222";
const SHELL: Capability[] = ["shell-double"];
const reviewCase = (name: string, fn: () => Promise<void>) => caseTest(TASK, name, SHELL, fn, TIMEOUT_MS);

useFixtureRoot();

const review = () => underTestSubmodule("submodule-review");

// Registers the superproject of `b` and reviews it.
async function reviewed(service: Service, b: Built, dir = superOf(b)): Promise<{ repositoryId: string; r: SubmoduleReview }> {
  await review();
  const { repositoryId } = await service.register(dir);
  return { repositoryId, r: await reviewSubmodules(service, repositoryId) };
}

// The stage-0 gitlinks of a superproject index, read with `ls-files -s -z`.
function gitlinks(b: Built, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const record of fixtureGit(b, dir, ["ls-files", "-s", "-z"]).split("\0")) {
    const m = /^160000 ([0-9a-f]+) 0\t(.*)$/s.exec(record);
    if (m) out[m[2]!] = m[1]!;
  }
  return out;
}

// Contract §12 "Discovery notice": a stage-0 gitlink counts when its path holds no `.git` entry, or when its HEAD differs from the recorded commit.
function expectedNotice(b: Built, dir: string, excluded: string[] = []): string[] {
  return Object.entries(gitlinks(b, dir))
    .filter(([path, oid]) => {
      if (excluded.includes(path)) return false;
      if (!existsSync(join(dir, path, ".git"))) return true;
      return fixtureGit(b, join(dir, path), ["rev-parse", "--verify", "-q", "HEAD"]).trim() !== oid;
    })
    .map(([path]) => path)
    .sort();
}

type Notice = { count: number; paths: string[]; filter: "applied" | "skipped" };
const noticeOf = (value: unknown) => valuesOf(value, "submoduleNotice")[0] as Notice | undefined;

// The config value of a key, or null.
const configValue = (b: Built, dir: string, args: string[]) => fixtureGit(b, dir, ["config", ...args], [0, 1]).trim() || null;

// Adds gitlinks with `.gitmodules` entries until the index holds one more than the §5 submodule review bound. No folder exists for them.
function passReviewBound(b: Built, dir: string): void {
  const have = Object.keys(gitlinks(b, dir)).length;
  const oid = Object.values(gitlinks(b, dir))[0]!;
  const extra = Array.from({ length: SUBMODULE_REVIEW_SUBMODULES + 1 - have }, (_, i) => `bulk${i}`);
  writeFileSync(join(dir, ".gitmodules"), readFileSync(join(dir, ".gitmodules"), "utf8") + extra.map((p) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = ../solo.git\n`).join(""));
  fixtureGit(b, dir, ["update-index", "--add", "--", ".gitmodules"]);
  const input = extra.map((p) => `160000 ${oid} 0\t${p}\0`).join("");
  ownedGit(gitPath(), FIXTURE_ROOT, dir, ["update-index", "-z", "--index-info"], { input: Buffer.from(input) });
}

// Contract §6 "Process fields": the UTF-16 units of the shell command line with its null. The program is quoted. The arguments hold no space, tab, or quote.
function unitsOf(program: string, args: readonly string[]): number {
  if (args.some((a) => a === "" || /[ \t"]/.test(a))) throw new Error("an argument needs quoting");
  return args.reduce((n, a) => n + 1 + a.length, program.length + 3);
}

// Contract §12 "Review reads": the top-level `diff-files -p` read of the initialized gitlinks.
const PATCH_ARGS = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "diff-files", "-p", "--ignore-submodules=dirty", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--"];

// Adds gitlinks with an empty `.git` folder, so that one `diff-files` batch of every initialized gitlink has exactly the command-line bound under `program`.
// Each `<dir>\<path>\.git` stays under the 260-unit MAX_PATH of Git for Windows without `core.longpaths`.
function fillPatchBatch(b: Built, dir: string, program: string): void {
  const links = gitlinks(b, dir);
  const initialized = Object.keys(links).filter((p) => existsSync(join(dir, p, ".git")));
  const budget = WINDOWS_COMMAND_LINE_UNITS - unitsOf(program, [...PATCH_ARGS, ...initialized]);
  const longest = 259 - join(dir, ".git").length - 1;
  const count = Math.ceil(budget / (longest + 1));
  if (count + Object.keys(links).length > SUBMODULE_REVIEW_SUBMODULES) throw new Error(`${count} gitlinks pass the review bound`);
  const base = Math.floor(budget / count) - 1;
  const extra = budget - count * (base + 1);
  const paths = Array.from({ length: count }, (_, i) => `${i}`.padEnd(base + (i < extra ? 1 : 0), "x"));
  for (const p of paths) mkdirSync(join(dir, p, ".git"), { recursive: true });
  const oid = Object.values(links)[0]!;
  ownedGit(gitPath(), FIXTURE_ROOT, dir, ["update-index", "-z", "--index-info"], { input: Buffer.from(paths.map((p) => `160000 ${oid} 0\t${p}\0`).join("")) });
}

describe("notice (contract §12 \"Discovery notice\")", () => {
  for (const variant of ["base", "behind-present", "behind-fetch"] as const) {
    caseTest(TASK, `F27 ${variant}: readWorkspace reports the uninitialized and the behind submodules, and starts no Git process inside a submodule`, SHELL, () => {
      const b = buildF27(gitPath(), `t222-notice-${variant}`, variant);
      return withFixture(b, `t222-notice-${variant}`, async (service) => {
        await underTestSubmodule("status");
        const { repositoryId } = await service.register(superOf(b));
        const read = await readOk(service, repositoryId);
        const paths = expectedNotice(b, superOf(b));
        expect(noticeOf(read)).toEqual({ count: paths.length, paths, filter: "applied" });
        expect(submoduleCalls(service, superOf(b)).map((c) => c.arguments)).toEqual([]);
      });
    }, TIMEOUT_MS);
  }

  caseTest(TASK, `F28 inactive: an explicit submodule.<name>.active=false excludes the gitlink from the notice`, SHELL, () => {
    const b = buildF28(gitPath(), "t222-notice-inactive", "inactive");
    return withFixture(b, "t222-notice-inactive", async (service) => {
      await underTestSubmodule("status");
      const { repositoryId } = await service.register(superOf(b));
      const paths = expectedNotice(b, superOf(b), ["solo"]);
      expect(paths).not.toContain("solo");
      expect(noticeOf(await readOk(service, repositoryId))).toEqual({ count: paths.length, paths, filter: "applied" });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `F29 base: readWorkspace starts no Git process inside a submodule, and no submodule canary runs`, SHELL, () => {
    const b = buildF29(gitPath(), "t222-notice-f29", "base");
    return withFixture(b, "t222-notice-f29", async (service) => {
      await underTestSubmodule("status");
      const { repositoryId } = await service.register(superOf(b));
      const read = await readOk(service, repositoryId);
      expect(ranCanaries(b)).toEqual([]);
      expect(submoduleCalls(service, superOf(b)).map((c) => c.arguments)).toEqual([]);
      const paths = expectedNotice(b, superOf(b));
      expect(paths).toContain("mid");
      expect(noticeOf(read)).toEqual({ count: paths.length, paths, filter: "applied" });
    });
  }, TIMEOUT_MS);
});

describe("plan (contract §12 \"Plan\")", () => {
  // The builder notes of each F27 variant (tests/git/fixtures.ts `buildF27`). Git's own update in a copy confirms each target.
  const ACTIONS: Record<F27Variant, Record<string, SubmoduleAction>> = {
    base: { mid: "clone", solo: "clone" },
    "behind-present": { mid: "clone", solo: "checkout" },
    "behind-fetch": { mid: "clone", solo: "fetch-checkout" },
    "deinit-kept": { mid: "clone", solo: "reuse" },
    "update-none": { mid: "clone", solo: "skip" },
    "literal-paths": { "sub[1]": "clone", sub1: "clone" },
    "kept-remote": { mid: "clone", solo: "reuse" },
    spaces: { mid: "clone", "sub dir/é sub": "clone" },
    "token-url": { mid: "clone", solo: "clone", review: "clone" },
    "unreachable-target": { mid: "clone", solo: "fetch-checkout" },
    "headless-kept": { mid: "reuse", solo: "clone" },
  };
  const FETCHES: Partial<Record<F27Variant, string[]>> = { "behind-fetch": ["solo"], "kept-remote": ["solo"], "unreachable-target": ["solo"] };

  for (const variant of Object.keys(ACTIONS) as F27Variant[]) {
    reviewCase(`F27 ${variant}: each row has the action and the notes that Git's own update in a copy confirms, and each URL equals the configured or .gitmodules value`, () => {
      const b = buildF27(gitPath(), `t222-plan-${variant}`, variant);
      const sup = superOf(b);
      const subs = b.facts.notes.submodules as Record<string, { name: string; url: string; recorded: string; head: string | null }>;
      const before = Object.fromEntries(Object.keys(ACTIONS[variant]).map((p) => [p, configValue(b, sup, ["--local", "--get", `submodule.${subs[p]!.name}.url`])]));
      const oracle = b.facts.notes.oracle === null ? null : oracleOf(b, "oracle-copy");
      return withFixture(b, `t222-plan-${variant}`, async (service) => {
        const { r } = await reviewed(service, b);
        expect(r.response.state).toBe("succeeded");
        expect(actionsOf(r)).toEqual(ACTIONS[variant]);
        for (const [path, action] of Object.entries(ACTIONS[variant])) {
          const row = rowOf(r, path);
          const s = subs[path]!;
          expect({ path, depth: row.depth, target: row.target, url: row.url }).toEqual({ path, depth: 0, target: s.recorded, url: redactUrlUserInfo(before[path] ?? s.url) });
          if (oracle !== null) expect({ path, oracle: action === "skip" ? undefined : s.recorded }).toEqual({ path, oracle: oracle.heads[path] });
          const expected: string[] = [];
          const registered = oracle !== null && before[path] === null && oracle.keys[`submodule.${s.name}.url`] !== undefined;
          if (registered) expected.push(NOTES.registers);
          if (before[path] === null && /^\.\.?\//.test(s.url)) expected.push(NOTES.relative);
          if ((FETCHES[variant] ?? []).includes(path)) expected.push(NOTES.fetches);
          if (s.head !== null && s.head !== s.recorded) expected.push(NOTES.moves(s.head, s.recorded));
          expect({ path, notes: row.notes }).toEqual({ path, notes: expect.arrayContaining(expected) });
        }
        if (variant === "token-url") {
          expect(rowOf(r, "review").url).toBe(redactUrlUserInfo(F27_TOKEN_URL));
          expect(rowOf(r, "review").url).toContain("<redacted>");
          // The token never leaves the service: no response and no log record holds it.
          expect(JSON.stringify(service.responses).includes("TOKEN")).toBe(false);
          expect(JSON.stringify(service.log()).includes("TOKEN")).toBe(false);
        }
      });
    });
  }

  reviewCase(`F27 behind-present at its target and initialized recursively: the row is none, and the nested row has depth 1 and its parent row`, () => {
    const b = buildF27(gitPath(), "t222-plan-none", "behind-present");
    const sup = superOf(b);
    const subs = b.facts.notes.submodules as Record<string, { recorded: string }>;
    fixtureGit(b, sup, ["submodule", "update", "--init", "--recursive", "-q", "--", "mid"]);
    fixtureGit(b, join(sup, "solo"), ["checkout", "-q", "--detach", subs.solo!.recorded]);
    return withFixture(b, "t222-plan-none", async (service) => {
      const { r } = await reviewed(service, b);
      expect(actionsOf(r)).toEqual({ mid: "none", solo: "none", "mid/leaf": "none" });
      const nested = rowOf(r, "mid/leaf");
      expect({ depth: nested.depth, parent: nested.parentRowId }).toEqual({ depth: 1, parent: rowOf(r, "mid").rowId });
    });
  });

  // Git keeps the submodule Git directories of a linked worktree in its own `modules` folder (`rev-parse --git-path modules`), not in the common directory.
  reviewCase(`F27 base in a linked worktree: a kept Git folder of that worktree makes the row reuse`, () => {
    const b = buildF27(gitPath(), "t222-plan-linked", "base");
    const linked = join(b.root, "linked");
    fixtureGit(b, superOf(b), ["worktree", "add", "-q", "--detach", linked]);
    fixtureGit(b, linked, ["submodule", "update", "--init", "-q", "--", "solo"]);
    fixtureGit(b, linked, ["submodule", "deinit", "-q", "-f", "--", "solo"]);
    const modules = fixtureGit(b, linked, ["rev-parse", "--path-format=absolute", "--git-path", "modules"]).trim();
    expect(existsSync(join(modules, "solo"))).toBe(true);
    return withFixture(b, "t222-plan-linked", async (service) => {
      const { r } = await reviewed(service, b, linked);
      expect(actionsOf(r)).toEqual({ mid: "clone", solo: "reuse" });
    });
  });

  reviewCase(`F27 unreachable-target: the row is fetch-checkout, and the runner sees rev-list -n 1 <target> --not --all in that submodule`, () => {
    const b = buildF27(gitPath(), "t222-plan-unreachable", "unreachable-target");
    const { path, target } = b.facts.notes.unreachable as { path: string; target: string };
    return withFixture(b, "t222-plan-unreachable", async (service) => {
      const { r } = await reviewed(service, b);
      expect(rowOf(r, path).action).toBe("fetch-checkout");
      const reach = submoduleCalls(service, superOf(b)).filter((c) => relative(join(superOf(b), path), resolve(superOf(b), gitLocation(c.arguments)!)) === "");
      expect(reach.map((c) => commandOf(c.arguments))).toContainEqual(["rev-list", "-n", "1", target, "--not", "--all"]);
    });
  });

  // The kept `solo` folder of F27 kept-remote: `origin` names a missing folder, and `good` names the `solo` remote.
  const keptRemotes = (b: Built, kept: string) =>
    Object.fromEntries(["origin", "good"].map((n) => [n, configValue(b, b.root, ["--file", join(kept, "config"), "--get", `remote.${n}.url`])]));

  reviewCase(`F27 kept-remote: the reuse row lists both remotes, redacted, and marks origin; without the matching remote it shows the differs note`, () => {
    const b = buildF27(gitPath(), "t222-kept-remotes", "kept-remote");
    const kept = join(b.root, (b.facts.notes.kept as Record<string, string>).solo!);
    const urls = keptRemotes(b, kept);
    const copy = copySuper(b, "super-one-remote");
    fixtureGit(b, b.root, ["--git-dir", moduleDirOf(b, copy, "solo"), "remote", "remove", "good"]);
    return withFixture(b, "t222-kept-remotes", async (service) => {
      const { r } = await reviewed(service, b);
      const row = rowOf(r, "solo");
      expect(row.remotes).toHaveLength(2);
      expect(row.remotes).toEqual(expect.arrayContaining([{ name: "origin", url: urls.origin, default: true }, { name: "good", url: urls.good, default: false }]));
      expect(row.notes).not.toContain(NOTES.remotesDiffer);
      const one = await reviewed(service, b, copy);
      expect(rowOf(one.r, "solo").notes).toContain(NOTES.remotesDiffer);
    });
  });

  reviewCase(`F27 kept-remote: a kept remote URL with a token shows <redacted> in the row, and no response or log holds the token`, () => {
    const b = buildF27(gitPath(), "t222-plan-kept-token", "kept-remote");
    const kept = join(b.root, (b.facts.notes.kept as Record<string, string>).solo!);
    fixtureGit(b, b.root, ["--git-dir", kept, "remote", "set-url", "good", "https://u:TOKEN@host.example/solo.git"]);
    return withFixture(b, "t222-plan-kept-token", async (service) => {
      const { r } = await reviewed(service, b);
      expect(rowOf(r, "solo").remotes).toContainEqual({ name: "good", url: "https://<redacted>@host.example/solo.git", default: false });
      expect(JSON.stringify(service.responses).includes("TOKEN")).toBe(false);
      expect(JSON.stringify(service.log()).includes("TOKEN")).toBe(false);
    });
  });

  reviewCase(`F28 inactive: active=false without submodule.active gives the activation note`, () => {
    const b = buildF28(gitPath(), "t222-plan-inactive", "inactive");
    return withFixture(b, "t222-plan-inactive", async (service) => {
      const { r } = await reviewed(service, b);
      expect(rowOf(r, "solo").notes).toContain(NOTES.activates);
    });
  });

  reviewCase(`F28 active-pathspec: a submodule outside the submodule.active pathspec is skip`, () => {
    const b = buildF28(gitPath(), "t222-plan-active-pathspec", "active-pathspec");
    return withFixture(b, "t222-plan-active-pathspec", async (service) => {
      const { r } = await reviewed(service, b);
      expect(actionsOf(r)).toEqual({ mid: "clone", solo: "skip" });
    });
  });

  reviewCase(`F27 update-none: the uninitialized update = none row is skip with the registration note`, () => {
    const b = buildF27(gitPath(), "t222-skip-update-none", "update-none");
    return withFixture(b, "t222-skip-update-none", async (service) => {
      const { r } = await reviewed(service, b);
      const row = rowOf(r, "solo");
      expect({ action: row.action, refusal: row.refusal }).toEqual({ action: "skip", refusal: null });
      expect(row.notes).toContain(NOTES.registers);
    });
  });

  reviewCase(`F27 base with .gitmodules update = rebase: the clone row does not refuse`, () => {
    const b = buildF27(gitPath(), "t222-plan-clone-rebase", "base");
    fixtureGit(b, superOf(b), ["config", "--file", ".gitmodules", "submodule.solo.update", "rebase"]);
    return withFixture(b, "t222-plan-clone-rebase", async (service) => {
      const { r } = await reviewed(service, b);
      expect({ action: rowOf(r, "solo").action, refusals: r.refusals }).toEqual({ action: "clone", refusals: [] });
    });
  });
});

describe("refusals (contract §12 \"Refusals\")", () => {
  type Expected = { path: string; reason: string; text: string; command: string | null; remedyText?: string };
  const unsaved = (b: Built): string => (b.facts.notes.unsaved as { commit: string }).commit;
  const kept = (b: Built, path: string) => resolve(b.root, (b.facts.notes.kept as Record<string, string>)[path]!);
  const mode = (b: Built, args: string[]) => configValue(b, superOf(b), args)!;
  const remoteName = (b: Built) => {
    const listing = fixtureGit(b, b.root, ["--git-dir", kept(b, "solo"), "config", "list", "-z"]).split("\0");
    const key = listing.map((e) => e.slice(0, e.indexOf("\n"))).find((k) => k.startsWith("remote.--"))!;
    return key.slice("remote.".length, -".url".length);
  };
  const CASES: [F28Variant, (b: Built) => Expected][] = [
    ["detached-unsaved", (b) => ({ path: "solo", reason: "unsaved-commits", text: TEXTS.unsavedCommits("solo", unsaved(b)), command: saveCommand({ worktree: join(superOf(b), "solo") }, unsaved(b)) })],
    ["deinit-unsaved", (b) => ({ path: "solo", reason: "unsaved-commits", text: TEXTS.unsavedCommits("solo", unsaved(b)), command: saveCommand({ gitDir: kept(b, "solo") }, unsaved(b)) })],
    ...(["update-merge", "update-rebase", "update-command"] as const).map(
      (v) => [v, (b: Built) => ({ path: "solo", reason: "update-mode", text: TEXTS.updateMode("solo", mode(b, ["--local", "--get", "submodule.solo.update"])), command: updateCommand(superOf(b), "solo"), remedyText: UPDATE_TEXT })] as [F28Variant, (b: Built) => Expected],
    ),
    ["gitmodules-command", (b) => ({ path: "solo", reason: "update-mode", text: TEXTS.updateMode("solo", mode(b, ["--file", ".gitmodules", "--get", "submodule.solo.update"])), command: updateCommand(superOf(b), "solo"), remedyText: UPDATE_TEXT })],
    ["no-url", () => ({ path: "orphan", reason: "no-url", text: TEXTS.noUrl("orphan"), command: null })],
    ["interrupted", () => ({ path: "solo", reason: "clone-interrupted", text: TEXTS.cloneInterrupted("solo"), command: null })],
    ["folder", () => ({ path: "solo", reason: "folder-not-empty", text: TEXTS.folderNotEmpty("solo"), command: null })],
    ["path", (b) => ({ path: shownPath(b.facts.notes.invalidPath as string), reason: "path", text: TEXTS.path(shownPath(b.facts.notes.invalidPath as string)), command: null })],
    ["remote-name", (b) => ({ path: "solo", reason: "remote-name", text: TEXTS.remoteName("solo", remoteName(b)), command: null })],
  ];
  // Data-model §5: each byte outside a well-formed UTF-8 sequence shows as a `\xNN` escape.
  function shownPath(hex: string): string {
    const bytes = Buffer.from(hex, "hex");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let out = "";
    for (let at = 0; at < bytes.length; ) {
      const n = [1, 2, 3, 4].find((k) => {
        try {
          return decoder.decode(bytes.subarray(at, at + k)).length > 0;
        } catch {
          return false;
        }
      });
      out += n === undefined ? `\\x${bytes[at]!.toString(16).padStart(2, "0")}` : decoder.decode(bytes.subarray(at, at + n));
      at += n ?? 1;
    }
    return out;
  }
  const shape = (x: SubmoduleRefusal) => ({ path: x.path, reason: x.reason, text: x.text, command: x.remedy?.command ?? null, ...(x.remedy?.text === undefined ? {} : { remedyText: x.remedy.text }) });

  for (const [variant, expected] of CASES) {
    reviewCase(`F28 ${variant}: the review gives UNSUPPORTED_SUBMODULE with its reason, its contract §12 text and remedy, and no canary runs`, () => {
      const b = buildF28(gitPath(), `t222-refuse-${variant}`, variant);
      const want = expected(b);
      return withFixture(b, `t222-refuse-${variant}`, async (service) => {
        const { r } = await reviewed(service, b);
        expect(ranCanaries(b)).toEqual([]);
        expect(r.refusals.map(shape)).toEqual([want]);
        expect(rowOf(r, want.path).refusal).toBe(want.reason as never);
      });
    });
  }

  // Contract §12 "Refusals" `clone-interrupted`: the HEAD read after `rev-parse --verify -q HEAD` fails. F28 interrupted writes `ref: refs/heads/main`, so `show-ref --exists` exits 2.
  for (const [id, head, label, code] of [
    ["placeholder", "ref: refs/heads/.invalid\n", "Git's clone placeholder target fails the ref-name rules, so the review refuses clone-interrupted", undefined],
    ["loop", "ref: refs/heads/loop\n", "a symbolic-ref loop exits 128, and its valid no-recurse target gives GIT_FAILED", "GIT_FAILED"],
    ["no-ref", "no ref\n", "a HEAD file that makes both symbolic-ref reads exit 128 gives GIT_FAILED", "GIT_FAILED"],
  ] as const) {
    reviewCase(`F28 interrupted: ${label}`, () => {
      const name = `t222-interrupted-${id}`;
      const b = buildF28(gitPath(), name, "interrupted");
      const gitDir = resolve(b.root, (b.facts.notes.interrupted as { gitDir: string }).gitDir);
      writeFileSync(join(gitDir, "HEAD"), head);
      if (id === "loop") put(gitDir, "refs/heads/loop", "ref: refs/heads/loop\n");
      return withFixture(b, name, async (service) => {
        const { r } = await reviewed(service, b);
        expect({ code: r.response.code, refusals: r.refusals.map(shape) }).toEqual(code === undefined ? { code: undefined, refusals: [{ path: "solo", reason: "clone-interrupted", text: TEXTS.cloneInterrupted("solo"), command: null }] } : { code, refusals: [] });
      });
    });
  }

  // Contract §12 "Review reads": `--git-dir=.git` after `-C <submodule worktree>`. Without it, Git discovery from that folder finds the superproject.
  caseTest("T231", `a submodule .git folder whose HEAD is not valid ends the review failed with GIT_FAILED; no read in it succeeds, and no token goes out`, SHELL, () => {
    const b = buildF27(gitPath(), "t231-invalid-git", "base");
    const sup = superOf(b);
    invalidGitFolder(join(sup, "solo"));
    expect(fixtureGit(b, join(sup, "solo"), ["rev-parse", "--absolute-git-dir"])).toBe(fixtureGit(b, sup, ["rev-parse", "--absolute-git-dir"]));
    return withFixture(b, "t231-invalid-git", async (service) => {
      const { r } = await reviewed(service, b);
      const inside = submoduleCalls(service, sup);
      expect({ code: r.response.code, token: r.token, reads: inside.length > 0, succeeded: inside.filter((c) => c.exit?.exitCode === 0).map((c) => c.arguments) }).toEqual({ code: "GIT_FAILED", token: undefined, reads: true, succeeded: [] });
    });
  }, TIMEOUT_MS);

  // Git resolves a one-level HEAD target as a ref name (refs.c `refs_resolve_ref_unsafe`, REFNAME_ALLOW_ONELEVEL). Only `reftable` stores `HEAD -> master`: setup.c `validate_headref` refuses a `ref: master` HEAD file.
  for (const present of [false, true]) {
    reviewCase(`F28 detached-unsaved: a reftable HEAD -> master ${present ? "gives the commit of master" : "without master refuses clone-interrupted"}`, () => {
      const name = `t222-onelevel-${present ? "present" : "missing"}`;
      const b = buildF28(gitPath(), name, "detached-unsaved");
      const solo = join(superOf(b), "solo");
      fixtureGit(b, solo, ["refs", "migrate", "--ref-format=reftable"]);
      ownedGit(gitPath(), FIXTURE_ROOT, solo, ["update-ref", "--no-deref", "--stdin"], { env: globalEnv(b), input: Buffer.from("symref-update HEAD master\n") });
      if (present) fixtureGit(b, solo, ["update-ref", "master", unsaved(b)]);
      expect(fixtureGit(b, solo, ["symbolic-ref", "-q", "HEAD"])).toBe("master\n");
      return withFixture(b, name, async (service) => {
        const { r } = await reviewed(service, b);
        expect({ code: r.response.code, head: r.rows.find((row) => row.path === "solo")?.head, reasons: r.refusals.map((x) => x.reason) }).toEqual(present ? { code: undefined, head: unsaved(b), reasons: ["unsaved-commits"] } : { code: undefined, head: null, reasons: ["clone-interrupted"] });
      });
    });
  }

  reviewCase(`F28 path: the review gives reason path, starts no Git process inside a submodule, and every repository digest stays equal`, () => {
    const b = buildF28(gitPath(), "t222-refuse-path-digests", "path");
    const sup = superOf(b);
    const before = { index: rawIndexDigest(gitPath(), sup), files: workingFileDigests(sup), refs: refState(gitPath(), sup) };
    return withFixture(b, "t222-refuse-path-digests", async (service) => {
      const { r } = await reviewed(service, b);
      expect(r.refusals.map((x) => x.reason)).toEqual(["path"]);
      expect(submoduleCalls(service, sup).map((c) => c.arguments)).toEqual([]);
      expect({ index: rawIndexDigest(gitPath(), sup), files: workingFileDigests(sup), refs: refState(gitPath(), sup) }).toEqual(before);
    });
  });

  reviewCase(`F28 folder: the folder check reads no file data; an absent folder and an empty folder pass`, () => {
    const b = buildF28(gitPath(), "t222-folder-reads", "folder");
    const absent = copySuper(b, "super-absent");
    rmSync(join(absent, "solo"), { recursive: true });
    const empty = copySuper(b, "super-empty");
    rmSync(join(empty, "solo"), { recursive: true });
    mkdirSync(join(empty, "solo"));
    return withFixture(b, "t222-folder-reads", async (service) => {
      const folder = join(superOf(b), "solo");
      const { calls } = await withFsCalls(async () => expect((await reviewed(service, b)).r.refusals.map((x) => x.reason)).toEqual(["folder-not-empty"]));
      expect(calls.filter((c) => c.name === "open" && !relative(folder, c.path).startsWith(".."))).toEqual([]);
      for (const dir of [absent, empty]) {
        const { r } = await reviewed(service, b, dir);
        expect({ dir, action: rowOf(r, "solo").action, refusals: r.refusals }).toEqual({ dir, action: "reuse", refusals: [] });
      }
    });
  });

  reviewCase(`F28 prune: the review passes with a fetch-checkout row, because every ref counts; for-each-ref runs without --exclude`, () => {
    const b = buildF28(gitPath(), "t222-refuse-prune", "prune");
    return withFixture(b, "t222-refuse-prune", async (service) => {
      const { r } = await reviewed(service, b);
      expect({ action: rowOf(r, "solo").action, refusals: r.refusals }).toEqual({ action: "fetch-checkout", refusals: [] });
      const refs = callsSince(service).filter((c) => commandOf(c.arguments)[0] === "for-each-ref");
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.flatMap((c) => c.arguments.filter((a) => a.startsWith("--exclude")))).toEqual([]);
    });
  });

  reviewCase(`F28 deinit-unsaved: the kept Git folder is read with --git-dir and --work-tree, and the review gives unsaved-commits`, () => {
    const b = buildF28(gitPath(), "t222-refuse-deinit", "deinit-unsaved");
    const dir = kept(b, "solo");
    return withFixture(b, "t222-refuse-deinit", async (service) => {
      const { r } = await reviewed(service, b);
      expect(r.refusals.map((x) => [x.path, x.reason])).toEqual([["solo", "unsaved-commits"]]);
      const reads = callsSince(service).filter((c) => commandOf(c.arguments)[0] === "for-each-ref" && c.arguments.some((a) => a.startsWith("--git-dir=") && relative(dir, a.slice(10)) === ""));
      expect(reads.map((c) => c.arguments.filter((a) => a.startsWith("--work-tree=")).map((a) => relative(dir, a.slice(12))))).toEqual([[""]]);
    });
  });

  reviewCase(`a nested kept folder with an unsaved HEAD that the walk finds gives unsaved-commits with the --git-dir save command`, () => {
    const b = buildF27(gitPath(), "t222-refuse-nested-kept", "base");
    const sup = superOf(b);
    fixtureGit(b, sup, ["submodule", "update", "--init", "--recursive", "-q", "--", "mid"]);
    const leaf = join(sup, "mid", "leaf");
    put(leaf, "local.txt", "local\n");
    fixtureGit(b, leaf, ["add", "--", "local.txt"]);
    fixtureGit(b, leaf, ["commit", "-q", "-m", "local"]);
    const commit = fixtureGit(b, leaf, ["rev-parse", "HEAD"]).trim();
    const leafDir = resolve(fixtureGit(b, leaf, ["rev-parse", "--absolute-git-dir"]).trim());
    fixtureGit(b, join(sup, "mid"), ["submodule", "deinit", "-q", "-f", "--", "leaf"]);
    return withFixture(b, "t222-refuse-nested-kept", async (service) => {
      const { r } = await reviewed(service, b);
      const found = r.refusals.filter((x) => x.reason === "unsaved-commits");
      expect(found.map((x) => ({ text: x.text, command: x.remedy?.command ?? null }))).toEqual([{ text: TEXTS.unsavedCommits(found[0]?.path ?? "", commit), command: saveCommand({ gitDir: leafDir }, commit) }]);
    });
  });

  reviewCase(`F28 detached-unsaved with update = merge: unsaved-commits comes before update-mode`, () => {
    const b = buildF28(gitPath(), "t222-refuse-two", "detached-unsaved");
    fixtureGit(b, superOf(b), ["config", "submodule.solo.update", "merge"]);
    return withFixture(b, "t222-refuse-two", async (service) => {
      const { r } = await reviewed(service, b);
      expect(r.refusals.map((x) => [x.path, x.reason])).toEqual([
        ["solo", "unsaved-commits"],
        ["solo", "update-mode"],
      ]);
    });
  });

  reviewCase(`a kept Git folder without a plan row that sets submodule.<name>.gitdir gives gitdir-config with its Git folder path and the update command without a path`, () => {
    const b = buildF27(gitPath(), "t222-refuse-kept-gitdir", "base");
    const sup = superOf(b);
    const extra = join(sup, ".git", "modules", "extra");
    fixtureGit(b, sup, ["init", "-q", "--bare", extra]);
    fixtureGit(b, b.root, ["config", "--file", join(extra, "config"), "submodule.x.gitdir", "elsewhere"]);
    return withFixture(b, "t222-refuse-kept-gitdir", async (service) => {
      const { r } = await reviewed(service, b);
      const found = r.refusals.filter((x) => x.reason === "gitdir-config");
      expect(found.map((x) => ({ at: relative(extra, x.path), text: x.text, command: x.remedy?.command ?? null }))).toEqual([{ at: "", text: TEXTS.gitdirConfig, command: updateCommand(sup) }]);
    });
  });

  // Git dies when it parses a `.gitmodules` update value `!command` or an unknown value, whatever the effective value (probe of 2026-10-09: exit 128).
  // The refusal names the value that refuses.
  for (const effective of ["none", "checkout"]) {
    reviewCase(`F28 gitmodules-command with effective update = ${effective}: the row refuses with update-mode and names the .gitmodules value`, () => {
      const b = buildF28(gitPath(), `t222-refuse-gitmodules-${effective}`, "gitmodules-command");
      const sup = superOf(b);
      fixtureGit(b, sup, ["config", "submodule.solo.update", effective]);
      const value = mode(b, ["--file", ".gitmodules", "--get", "submodule.solo.update"]);
      return withFixture(b, `t222-refuse-gitmodules-${effective}`, async (service) => {
        const { r } = await reviewed(service, b);
        expect(r.refusals.map(shape)).toEqual([{ path: "solo", reason: "update-mode", text: TEXTS.updateMode("solo", value), command: updateCommand(sup, "solo"), remedyText: UPDATE_TEXT }]);
        expect(rowOf(r, "solo").refusal).toBe("update-mode");
      });
    });
  }

  // Git `parse_submodule_update_type` knows `none`, `checkout`, `rebase`, `merge`, and `!command`. Another value exits 128 from either source, also for a clone (probe of 2026-10-09).
  for (const source of [".gitmodules", "local"] as const) {
    reviewCase(`F27 base with the ${source} update value foo: the clone row refuses with update-mode`, () => {
      const b = buildF27(gitPath(), `t222-refuse-unknown-${source.replace(".", "")}`, "base");
      const sup = superOf(b);
      fixtureGit(b, sup, ["config", ...(source === "local" ? [] : ["--file", ".gitmodules"]), "submodule.solo.update", "foo"]);
      return withFixture(b, `t222-refuse-unknown-${source.replace(".", "")}`, async (service) => {
        const { r } = await reviewed(service, b);
        expect(r.refusals.map(shape)).toEqual([{ path: "solo", reason: "update-mode", text: TEXTS.updateMode("solo", "foo"), command: updateCommand(sup, "solo"), remedyText: UPDATE_TEXT }]);
        expect({ action: rowOf(r, "solo").action, refusal: rowOf(r, "solo").refusal }).toEqual({ action: "clone", refusal: "update-mode" });
      });
    });
  }

  // The task names a test-injected bound. No seam lowers the §5 bound, so the copy holds one gitlink more than SUBMODULE_REVIEW_SUBMODULES.
  reviewCase(`F27 base with ${SUBMODULE_REVIEW_SUBMODULES + 1} gitlinks gives limit with the update command without a path`, () => {
    const b = buildF27(gitPath(), "t222-refuse-limit", "base");
    passReviewBound(b, superOf(b));
    return withFixture(b, "t222-refuse-limit", async (service) => {
      const { r } = await reviewed(service, b);
      const limit = r.refusals.filter((x) => x.reason === "limit");
      expect(limit.map((x) => ({ text: x.text, command: x.remedy?.command ?? null, remedyText: x.remedy?.text }))).toEqual([{ text: TEXTS.limit, command: updateCommand(superOf(b)), remedyText: UPDATE_TEXT }]);
    });
  });

  // Contract §6 "Process fields": the shell starts `executablePath`, and the command-line bound counts that program.
  // The added gitlinks fill one `diff-files` batch to the bound under `selectedPath`. Under `executablePath`, that batch is too long.
  reviewCase(`a diff-files batch that fits only under the selected Git path splits under the executable path, and the shell refuses no call`, () => {
    const b = buildF27(gitPath(), "t222-batch-units", "base");
    const sup = superOf(b);
    return withFixture(b, "t222-batch-units", async (service) => {
      const env = await service.request<{ selectedPath: string; executablePath: string }>("getEnvironment", {});
      const { selectedPath, executablePath } = env.result!;
      expect(executablePath.length).toBeGreaterThan(selectedPath.length);
      fillPatchBatch(b, sup, selectedPath);
      const from = callsSince(service).length;
      const { r } = await reviewed(service, b);
      const calls = callsSince(service, from);
      expect(calls.filter((c) => c.refused !== undefined).map((c) => c.refused)).toEqual([]);
      expect(r.response.code).not.toBe("INVALID_REQUEST");
      const batches = calls.filter((c) => commandOf(c.arguments)[0] === "diff-files").map((c) => c.arguments);
      const fixed = batches[0]!.slice(0, batches[0]!.indexOf("--") + 1);
      const paths = batches.flatMap((args) => args.slice(args.indexOf("--") + 1));
      expect(unitsOf(selectedPath, [...fixed, ...paths])).toBe(WINDOWS_COMMAND_LINE_UNITS);
      expect(batches.map((args) => unitsOf(executablePath, args) <= WINDOWS_COMMAND_LINE_UNITS)).toEqual([true, true]);
    });
  });

  reviewCase(`a copy with update-mode, gitdir-config, and limit beside unsaved-commits and no-url lists unsaved-commits and no-url first`, () => {
    const b = buildF28(gitPath(), "t222-refuse-order", "detached-unsaved");
    const sup = superOf(b);
    fixtureGit(b, sup, ["config", "submodule.solo.update", "merge"]);
    fixtureGit(b, sup, ["config", "submodule.solo.gitdir", join(b.root, "outside", "solo").replaceAll("\\", "/")]);
    const oid = gitlinks(b, sup).solo!;
    mkdirSync(join(sup, "orphan"));
    ownedGit(gitPath(), FIXTURE_ROOT, sup, ["update-index", "-z", "--index-info"], { input: Buffer.from(`160000 ${oid} 0\torphan\0`) });
    passReviewBound(b, sup);
    return withFixture(b, "t222-refuse-order", async (service) => {
      const { r } = await reviewed(service, b);
      const reasons = r.refusals.map((x) => x.reason);
      expect(reasons).toHaveLength(5);
      expect(reasons.slice(0, 2).sort()).toEqual(["no-url", "unsaved-commits"]);
      expect(reasons.slice(2).sort()).toEqual(["gitdir-config", "limit", "update-mode"]);
      const gitdir = r.refusals.find((x) => x.reason === "gitdir-config")!;
      expect({ text: gitdir.text, command: gitdir.remedy?.command ?? null }).toEqual({ text: TEXTS.gitdirConfig, command: updateCommand(sup) });
    });
  });

  reviewCase(`a test-injected folder read error gives REPOSITORY_UNAVAILABLE with the path, and no token goes out`, () => {
    const b = buildF27(gitPath(), "t222-refuse-folder-error", "deinit-kept");
    const folder = join(superOf(b), "solo");
    return withFixture(b, "t222-refuse-folder-error", async (service) => {
      await review();
      const { repositoryId } = await service.register(superOf(b));
      const read = await readOk(service, repositoryId);
      const { value: r } = await withFsCalls(
        () => reviewSubmodules(service, repositoryId, read),
        (call) => {
          if ((call.name === "lstat" || call.name === "readdir") && relative(folder, call.path) === "") throw Object.assign(new Error(`EACCES: ${call.path}`), { code: "EACCES" });
        },
      );
      expect({ code: r.response.code, token: r.token }).toEqual({ code: "REPOSITORY_UNAVAILABLE", token: undefined });
      expect(valuesOf(r.response.result, "path").map((p) => relative(folder, String(p)))).toContain("");
    });
  });
});

describe("programs (contract §12 \"Trust\")", () => {
  // The script file of a canary: `<root>/canaries/<name>.sh` beside its log.
  const script = (b: Built, name: string) => join(b.root, b.facts.canaries[name]!.replace(/\.log$/, ".sh"));
  const gitDirOf = (b: Built, label: string) => join(b.root, (b.facts.notes.programs as Record<string, string>)[label]!);
  const hookDigests = (b: Built, label: string) => (b.facts.notes.hookEvents as string[]).map((e) => fileSha256(join(gitDirOf(b, label), "hooks", e)));
  // The `programCanaries` keys as `config list` names them, and whether the §7 value display allowlist shows the value.
  // Feature 003 contract Δ7 adds the transport programs to the allowlist.
  const CANARY_KEYS: [key: string, canary: string, shown: boolean][] = [
    ["core.fsmonitor", "fsmonitor", true],
    ["filter.f29.clean", "clean", true],
    ["filter.f29.smudge", "smudge", true],
    ["core.sshcommand", "ssh", true],
    ["credential.helper", "credential", true],
    ["remote.origin.uploadpack", "uploadpack", true],
  ];
  // Contract §7 "Program file digests": the canary scripts lie outside every root, so each entry is `unchecked` with its location.
  const expectOutsideCanaries = (b: Built, r: SubmoduleReview, label: string) => {
    const config = join(gitDirOf(b, label), "config");
    for (const [key, canary, shown] of CANARY_KEYS) {
      const entries = r.programs.filter((p) => p.key === key && p.origin.startsWith("file:") && relative(config, p.origin.slice(5)) === "").map((p) => ({ program: p.program, digest: p.digest }));
      expect({ label, key, entries: [...new Set(entries.map((e) => JSON.stringify(e)))] }).toEqual({ label, key, entries: [JSON.stringify({ program: shown ? script(b, `${label}-${canary}`) : "", digest: "unchecked" })] });
    }
  };

  reviewCase(`F29 base: the review lists every canary program with its origin and digest, and no canary runs during the review`, () => {
    const b = buildF29(gitPath(), "t222-programs-base", "base");
    return withFixture(b, "t222-programs-base", async (service) => {
      const { r } = await reviewed(service, b);
      expect(ranCanaries(b)).toEqual([]);
      const digests = r.programs.map((p) => p.digest);
      for (const label of ["mid", "mid-leaf"]) {
        for (const d of hookDigests(b, label)) expect({ label, d, listed: digests.includes(d) }).toEqual({ label, d, listed: true });
        expectOutsideCanaries(b, r, label);
      }
      expect(r.programs.every((p) => p.origin !== "")).toBe(true);
      expect(r.programs.filter((p) => p.key === "core.fsmonitor").map((p) => [p.program, p.digest]).sort()).toEqual([[script(b, "mid-fsmonitor"), "unchecked"], [script(b, "mid-leaf-fsmonitor"), "unchecked"]].sort());
    });
  });

  reviewCase(`F29 relative-hooks: the review lists one unchecked hooks directory for each clone, reuse, checkout, and fetch-checkout row, and one more for a row without its local target commit`, () => {
    const b = buildF29(gitPath(), "t222-programs-relative", "relative-hooks");
    const paths = Object.keys(b.facts.notes.rows as Record<string, string>);
    const target = (b.facts.notes.commits as { B: string }).B;
    // Contract §12 "Review reads": without a local target commit, the nested submodules stay unknown until the update fetches.
    const local = (path: string) => {
      const dir = moduleDirOf(b, superOf(b), path);
      return existsSync(dir) && fixtureGit(b, b.root, ["--git-dir", dir, "rev-parse", "--verify", "-q", `${target}^{commit}`], [0, 1]).trim() === target;
    };
    const expected = paths.map((path) => ({ path, keys: local(path) ? ["core.hooksPath"] : ["core.hooksPath", "core.hooksPath"] }));
    expect(expected.filter((e) => e.keys.length === 2).length).toBeGreaterThan(0);
    return withFixture(b, "t222-programs-relative", async (service) => {
      const { r } = await reviewed(service, b);
      expect(actionsOf(r)).toEqual(b.facts.notes.rows as Record<string, SubmoduleAction>);
      const unchecked = r.programs.filter((p) => p.digest === "unchecked");
      const perRow = paths.map((path) => ({ path, keys: unchecked.filter((p) => "rowId" in p && p.rowId === rowOf(r, path).rowId).map((p) => p.key) }));
      expect(perRow).toEqual(expected);
    });
  });

  // `--git-dir=<folder>` and `--work-tree=<folder>` of each `rev-parse --absolute-git-dir` call, as folder paths.
  // T148: a row read prints the Git directory and the hooks path in one process, and the walk starts no read in that directory.
  const walkReads = (service: Service) =>
    callsSince(service)
      .filter((c) => ["rev-parse --absolute-git-dir", "rev-parse --absolute-git-dir --git-path hooks"].includes(commandOf(c.arguments).join(" ")))
      .map((c) => ({ gitDir: c.arguments.find((a) => a.startsWith("--git-dir="))?.slice(10), workTree: c.arguments.find((a) => a.startsWith("--work-tree="))?.slice(12) }));

  reviewCase(`F29 kept-folder: the review lists the canaries of the top-level and the nested kept Git folder, reads each with --git-dir=<folder> --work-tree=<folder>, skips the non-Git folder, and finds the name with /`, () => {
    const b = buildF29(gitPath(), "t222-programs-kept", "kept-folder");
    const keptDirs = Object.values(b.facts.notes.kept as Record<string, string>).map((d) => join(b.root, d));
    const nonGit = join(b.root, b.facts.notes.nonGitFolder as string);
    return withFixture(b, "t222-programs-kept", async (service) => {
      const { r } = await reviewed(service, b);
      expect(ranCanaries(b)).toEqual([]);
      const digests = r.programs.map((p) => p.digest);
      for (const label of ["mid", "mid-leaf"]) {
        for (const d of hookDigests(b, label)) expect({ label, listed: digests.includes(d) }).toEqual({ label, listed: true });
        expectOutsideCanaries(b, r, label);
      }
      const reads = walkReads(service);
      for (const dir of keptDirs) expect({ dir, read: reads.some((x) => x.gitDir !== undefined && relative(dir, x.gitDir) === "" && x.workTree !== undefined && relative(dir, x.workTree) === "") }).toEqual({ dir, read: true });
      expect(r.programs.filter((p) => "gitDirectory" in p && !relative(nonGit, p.gitDirectory).startsWith(".."))).toEqual([]);
    });
  });

  reviewCase(`F29 kept-nested: the review lists the canaries of the nested kept folder inside an initialized submodule`, () => {
    const b = buildF29(gitPath(), "t222-programs-kept-nested", "kept-nested");
    return withFixture(b, "t222-programs-kept-nested", async (service) => {
      const { r } = await reviewed(service, b);
      expect(ranCanaries(b)).toEqual([]);
      const digests = r.programs.map((p) => p.digest);
      for (const d of hookDigests(b, "mid-leaf")) expect(digests).toContain(d);
      expectOutsideCanaries(b, r, "mid-leaf");
    });
  });

  // Contract §12 "Trust": a submodule listing uses the superproject roots as the repository directories.
  // A global `core.sshCommand` in the superproject worktree runs during each fetch, so each fetching row lists it with its digest.
  for (const [variant, action] of [["base", "clone"], ["behind-fetch", "fetch-checkout"], ["kept-remote", "reuse"]] as const) {
    reviewCase(`F27 ${variant}: a global core.sshCommand in the superproject worktree is listed with its digest in the ${action} row`, () => {
      const b = buildF27(gitPath(), `t222-programs-super-roots-${variant}`, variant);
      const ssh = put(superOf(b), "tools/ssh.sh", "#!/bin/sh\nexit 1\n").replaceAll("\\", "/");
      appendFileSync(join(b.root, b.facts.notes.globalConfig as string), `[core]\n\tsshCommand = '${ssh}'\n`);
      return withFixture(b, `t222-programs-super-roots-${variant}`, async (service) => {
        const { r } = await reviewed(service, b);
        const row = rowOf(r, "solo");
        const listed = r.programs.filter((p) => "rowId" in p && p.rowId === row.rowId && p.key === "core.sshcommand").map((p) => p.digest);
        expect({ action: row.action, listed }).toEqual({ action, listed: [fileSha256(ssh)] });
      });
    });
  }

  // Contract §12 "Trust" and §6 "File facts": a submodule Git directory outside the superproject roots gives locations only, with digest `unchecked`.
  reviewCase(`F27 behind-present with the solo Git directory outside the superproject: its hooks folder and a global program in it are unchecked locations`, () => {
    const b = buildF27(gitPath(), "t222-programs-outside-gitdir", "behind-present");
    const sup = superOf(b);
    const inside = moduleDirOf(b, sup, "solo");
    const moved = join(b.root, "outside-solo.git");
    renameSync(inside, moved);
    const slash = (p: string) => p.replaceAll("\\", "/");
    writeFileSync(join(sup, "solo", ".git"), `gitdir: ${slash(moved)}\n`);
    fixtureGit(b, b.root, ["config", "--file", join(moved, "config"), "core.worktree", slash(join(sup, "solo"))]);
    const helper = slash(put(moved, "cred.sh", "#!/bin/sh\nexit 2\n"));
    appendFileSync(join(b.root, b.facts.notes.globalConfig as string), `[credential]\n\thelper = ${helper}\n`);
    return withFixture(b, "t222-programs-outside-gitdir", async (service) => {
      const { r } = await reviewed(service, b);
      const row = rowOf(r, "solo");
      const listed = r.programs.filter((p) => "rowId" in p && p.rowId === row.rowId && (p.key === "core.hooksPath" || p.key === "credential.helper")).map((p) => ({ key: p.key, at: p.key === "core.hooksPath" ? relative(join(moved, "hooks"), p.program) : "", digest: p.digest }));
      expect({ action: row.action, listed }).toEqual({ action: "checkout", listed: expect.arrayContaining([{ key: "core.hooksPath", at: "", digest: "unchecked" }, { key: "credential.helper", at: "", digest: "unchecked" }]) });
      expect(listed).toHaveLength(2);
    });
  });

  // The task names a test-injected walk. No seam lowers the §5 bound, so the copy holds one folder more than SUBMODULE_REVIEW_SUBMODULES under `modules`.
  const walkLimit = (name: string, readDeadlineMs?: number) => {
    const b = buildF27(gitPath(), name, "base");
    const modules = join(superOf(b), ".git", "modules", "walk");
    for (let i = 0; i <= SUBMODULE_REVIEW_SUBMODULES; i++) mkdirSync(join(modules, `f${i}`), { recursive: true });
    return withFixture(
      b,
      name,
      async (service) => {
        const start = performance.now();
        const { r } = await reviewed(service, b);
        const elapsed = performance.now() - start;
        console.log(`${name}: review ${Math.round(elapsed)} ms, response wait ${NO_TOTAL_DEADLINE_WAIT_MS} ms, old wait ${RESPONSE_WAIT_MS} ms`);
        // A review inside the injected deadline proves nothing about the missing total timer.
        if (readDeadlineMs !== undefined) expect({ premise: "review outlasts the injected read deadline", readDeadlineMs, elapsed, ok: elapsed > readDeadlineMs }).toEqual({ premise: "review outlasts the injected read deadline", readDeadlineMs, elapsed, ok: true });
        expect({ state: r.response.state, code: r.response.code, refusals: r.refusals.map((x) => ({ reason: x.reason, text: x.text })) }).toEqual({ state: "succeeded", code: undefined, refusals: [{ reason: "limit", text: TEXTS.limit }] });
      },
      readDeadlineMs === undefined ? {} : { readDeadlineMs },
    );
  };

  reviewCase(`a modules walk above ${SUBMODULE_REVIEW_SUBMODULES} folders gives limit`, () => walkLimit("t222-programs-walk"));

  // Contract §5 "Ordinary read deadline": `reviewSubmodules` has no total read deadline.
  reviewCase(`T382: a modules walk above ${SUBMODULE_REVIEW_SUBMODULES} folders gives limit after the read deadline passes`, () => walkLimit("t382-programs-walk", 3_000));

  reviewCase(`F29 base: inside submodules, the runner sees only the review reads, each with --no-lazy-fetch --no-optional-locks first`, () => {
    const b = buildF29(gitPath(), "t222-programs-reads", "base");
    return withFixture(b, "t222-programs-reads", async (service) => {
      await reviewed(service, b);
      const inside = submoduleCalls(service, superOf(b));
      expect(inside.length).toBeGreaterThan(0);
      expect(inside.filter((c) => !isReviewRead(c.arguments)).map((c) => c.arguments)).toEqual([]);
    });
  });

  reviewCase(`the review waits for read trust like other reads: after Revoke trust it gives TRUST_REQUIRED and starts no Git process inside a submodule`, () => {
    const b = buildF27(gitPath(), "t222-programs-trust", "behind-present");
    const monitor = put(b.root, "programs/monitor.sh", "#!/bin/sh\nexit 1\n").replaceAll("\\", "/");
    fixtureGit(b, superOf(b), ["config", "core.fsmonitor", `'${monitor}'`]);
    return withFixture(b, "t222-programs-trust", async (service) => {
      await review();
      const { repositoryId } = await service.register(superOf(b));
      const trust = await service.readTrust(repositoryId);
      expect(trust.result!.approvalRequired.reads).toBe(true);
      await service.approveTrust(repositoryId);
      const read = await readOk(service, repositoryId);
      const trustId = (await service.readTrust(repositoryId)).result!.trustId!;
      expect((await service.revokeTrust(repositoryId, trustId)).state).toBe("succeeded");
      const from = service.runner.calls.length;
      const r = await reviewSubmodules(service, repositoryId, read);
      expect({ code: r.response.code, succeeded: r.response.state === "succeeded" }).toEqual({ code: "TRUST_REQUIRED", succeeded: false });
      expect(submoduleCalls(service, superOf(b), from).map((c) => c.arguments)).toEqual([]);
    });
  });
});

describe("token (contract §12 \"Update protocol\" step 2, §9)", () => {
  type Change = { variant: F27Variant | "f29"; change: (b: Built) => void };
  const CHANGES: Record<string, Change> = {
    "a submodule HEAD": { variant: "behind-present", change: (b) => void fixtureGit(b, join(superOf(b), "solo"), ["checkout", "-q", "--detach", (b.facts.notes.submodules as Record<string, { recorded: string }>).solo!.recorded]) },
    "a .gitmodules byte": { variant: "base", change: (b) => writeFileSync(join(superOf(b), ".gitmodules"), `${readFileSync(join(superOf(b), ".gitmodules"), "utf8")}\n`) },
    "a program file byte": {
      variant: "f29",
      change: (b) => {
        const hook = join(b.root, (b.facts.notes.programs as Record<string, string>).mid!, "hooks", "post-checkout");
        writeFileSync(hook, `${readFileSync(hook, "utf8")}# changed\n`);
      },
    },
    "the superproject HEAD": {
      variant: "base",
      change: (b) => {
        const sup = superOf(b);
        const next = fixtureGit(b, sup, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "external"]).trim();
        fixtureGit(b, sup, ["update-ref", "refs/heads/main", next]);
      },
    },
  };

  // Research R14 S39: a preflight reviews again, so an unchanged repository must give equal digests. The case records each issued binding.
  reviewCase(`F27 base: two reviews give equal review and programs digests`, async () => {
    const b = buildF27(gitPath(), "t222-token-stable", "base");
    const bindings: approvalsModule.SubmoduleBinding[] = [];
    const create = approvalsModule.createApprovals;
    const spy = spyOn(approvalsModule, "createApprovals").mockImplementation((now) => {
      const store = create(now);
      const issue = store.issue;
      store.issue = (approval) => {
        if (approval.kind === "submodule") bindings.push(approval.binding);
        return issue(approval);
      };
      return store;
    });
    try {
      await withFixture(b, "t222-token-stable", async (service) => {
        const { repositoryId, r } = await reviewed(service, b);
        const again = await reviewSubmodules(service, repositoryId);
        expect({ rows: r.rows.length, tokens: [typeof r.token, typeof again.token] }).toEqual({ rows: 2, tokens: ["string", "string"] });
        expect(bindings.map((x) => ({ review: x.review, programs: x.programs }))).toEqual([
          { review: bindings[0]!.review, programs: bindings[0]!.programs },
          { review: bindings[0]!.review, programs: bindings[0]!.programs },
        ]);
      });
    } finally {
      spy.mockRestore();
    }
  });

  for (const [what, { variant, change }] of Object.entries(CHANGES)) {
    reviewCase(`a change of ${what} after the review makes updateSubmodules give STALE_REVIEW, and no update step starts`, () => {
      const name = `t222-token-${what.replaceAll(/[^a-z]+/g, "-")}`;
      const b = variant === "f29" ? buildF29(gitPath(), name, "base") : buildF27(gitPath(), name, variant);
      return withFixture(
        b,
        name,
        async (service) => {
          const { repositoryId, r } = await reviewed(service, b);
          await underTestSubmodule("submodule-update");
          change(b);
          const from = service.runner.calls.length;
          const response = await updateSubmodules(service, repositoryId, r);
          expect({ code: response.code, steps: updateSteps(service, from).map((c) => c.arguments), canaries: ranCanaries(b) }).toEqual({ code: "STALE_REVIEW", steps: [], canaries: [] });
        },
        { watchHints: false },
      );
    });
  }

  // 001 contract §7 "Shared listing": a review after the second read of a generation takes the listing of that read. The first read shares none.
  const LISTING = "config list --show-scope --show-origin -z";
  const superReads = (service: Service, sup: string, from: number) => callsSince(service, from).filter((c) => !insideSubmodule(sup, c.arguments)).map((c) => commandOf(c.arguments).join(" "));
  for (const kind of ["no submodule", "F27 base"] as const) {
    reviewCase(`${kind}: a review after the second read of its generation runs no own trust listing, and its rows and token equal those of a review with its own listing`, () => {
      const b = buildF27(gitPath(), `t222-token-shared-${kind.replaceAll(" ", "-").toLowerCase()}`, "base");
      let dir = superOf(b);
      if (kind === "no submodule") {
        dir = join(b.root, "plain");
        mkdirSync(dir);
        fixtureGit(b, dir, ["init", "-q", "-b", "main"]);
        put(dir, "a.txt", "a\n");
        fixtureGit(b, dir, ["add", "--", "a.txt"]);
        fixtureGit(b, dir, ["commit", "-q", "-m", "a"]);
      }
      return withFixture(
        b,
        `t222-token-shared-${kind}`,
        async (service) => {
          await review();
          const { repositoryId } = await service.register(dir);
          const first = await readOk(service, repositoryId);
          let from = service.runner.calls.length;
          const own = await reviewSubmodules(service, repositoryId, first);
          const ownReads = superReads(service, dir, from);
          const second = await readOk(service, repositoryId);
          from = service.runner.calls.length;
          const shared = await reviewSubmodules(service, repositoryId, second);
          const sharedReads = superReads(service, dir, from);
          console.log(`PROCESSES ${kind}: own listing ${ownReads.length} [${ownReads.join(" | ")}], shared listing ${sharedReads.length} [${sharedReads.join(" | ")}]`);
          expect({ own: own.response.state, shared: shared.response.state, rows: shared.rows.length }).toEqual({ own: "succeeded", shared: "succeeded", rows: kind === "no submodule" ? 0 : 2 });
          expect(ownReads.filter((c) => c === LISTING).length).toBe(1);
          expect(sharedReads.filter((c) => c === LISTING)).toEqual([]);
          expect(sharedReads.length).toBeLessThan(ownReads.length);
          const strip = (r: SubmoduleReview) => r.rows.map((row) => ({ ...row, rowId: undefined, parentRowId: undefined }));
          expect({ rows: strip(shared), programs: shared.programs }).toEqual({ rows: strip(own), programs: own.programs });
        },
        { watchHints: false },
      );
    });
  }

  reviewCase(`a token older than APPROVAL_LIFETIME_MS on an injected clock gives APPROVAL_EXPIRED, and no Git process starts`, () => {
    const b = buildF27(gitPath(), "t222-token-expired", "base");
    // The approval lifetime runs on the monotonic service clock (T110 decision G5). The case moves that clock.
    let elapsed = 0;
    const approvalClock = () => performance.now() + elapsed;
    return withFixture(
      b,
      "t222-token-expired",
      async (service) => {
        const { repositoryId, r } = await reviewed(service, b);
        expect(typeof r.token).toBe("string");
        await underTestSubmodule("submodule-update");
        const from = service.runner.calls.length;
        elapsed = APPROVAL_LIFETIME_MS + 1;
        const response = await updateSubmodules(service, repositoryId, r);
        expect({ code: response.code, runs: service.runner.calls.length - from }).toEqual({ code: "APPROVAL_EXPIRED", runs: 0 });
      },
      { approvalClock },
    );
  });
});

// ---- Feature 004 User Story 12: row order (T136) and branch marks (T139) ----

// Registers the superproject of a tree world and reviews it.
async function reviewedTree(service: Service, w: TreeWorld): Promise<{ repositoryId: string; r: SubmoduleReview }> {
  await review();
  const { repositoryId } = await service.register(w.sup);
  return { repositoryId, r: await reviewSubmodules(service, repositoryId) };
}
const withTree = (w: TreeWorld, name: string, body: (service: Service) => Promise<void>) => withService({ name, environment: serviceEnv(w.env) }, body);

describe("row order (004 FR-077, contract Δ12 \"Row order\")", () => {
  caseTest("T136", "a(a/x) b c(c/y(c/y/z)): the review and the update list each nested row directly after its parent row, with its depth and its parent row", SHELL, () => {
    const w = treeWorld("t136-order", { a: { x: {} }, b: {}, c: { y: { z: {} } } });
    return withTree(w, "t136-order", async (service) => {
      const { repositoryId, r } = await reviewedTree(service, w);
      const pathOf = new Map(r.rows.map((row) => [row.rowId, row.path]));
      const rows = r.rows.map((row) => [row.path, row.depth, row.parentRowId === null ? null : (pathOf.get(row.parentRowId) ?? "unknown")]);
      console.log(`OBSERVATION T136: review rows ${JSON.stringify(rows)}`);
      expect({ outcome: outcome(r.response), rows }).toEqual({ outcome: SUCCEEDED, rows: [["a", 0, null], ["a/x", 1, "a"], ["b", 0, null], ["c", 0, null], ["c/y", 1, "c"], ["c/y/z", 2, "c/y"]] });
      await underTestSubmodule("submodule-update");
      const updated = await updateSubmodules(service, repositoryId, r);
      expect({ outcome: outcome(updated), rows: resultsOf(updated).map((row) => row.path) }).toEqual({ outcome: SUCCEEDED, rows: ["a", "a/x", "b", "c", "c/y", "c/y/z"] });
    });
  }, TIMEOUT_MS);
});

describe("branch marks (004 FR-109, FR-110, contract Δ12 \"Branch marks\", data-model §15)", () => {
  type Mark = { rowId: string; state: string; ref?: string; upstream?: string | null; track?: object; code?: string };
  type Call = { arguments: readonly string[] };
  type Spec = { setup: string[][]; want: object };
  const markCase = (name: string, fn: () => Promise<void>) => caseTest("T139", name, SHELL, fn, TIMEOUT_MS);
  // Git's own update leaves each submodule detached at `second`, the tip of `origin/main`. `first` is `second~1`.
  const TRACK_MAIN = ["checkout", "-q", "-B", "main", "--track", "origin/main"];
  const BEHIND = [["checkout", "-q", "-B", "main", "origin/main~1"], ["branch", "-q", "--set-upstream-to=origin/main"]];
  const NONE = { state: "none" };
  const counts = (ahead: number, behind: number) => ({ state: "counts", ahead, behind });
  const onMain = (track: object) => ({ state: "branch", ref: "refs/heads/main", upstream: "refs/remotes/origin/main", track });
  // The setup commands of each submodule worktree, and the mark that the setup gives.
  const SPECS = {
    equal: { setup: [TRACK_MAIN], want: onMain(counts(0, 0)) },
    ahead: { setup: [TRACK_MAIN, ["commit", "-q", "--allow-empty", "-m", "ahead"]], want: onMain(counts(1, 0)) },
    behind: { setup: BEHIND, want: onMain(counts(0, 1)) },
    diverged: { setup: [...BEHIND, ["commit", "-q", "--allow-empty", "-m", "diverged"]], want: onMain(counts(1, 1)) },
    gone: {
      setup: [["checkout", "-q", "-b", "topic", "--track", "origin/main"], ["config", "branch.topic.merge", "refs/heads/missing"]],
      want: { state: "branch", ref: "refs/heads/topic", upstream: "refs/remotes/origin/missing", track: { state: "gone" } },
    },
    "no-upstream": { setup: [["checkout", "-q", "-b", "own"]], want: { state: "branch", ref: "refs/heads/own", upstream: null, track: NONE } },
    "no-remote": {
      setup: [["checkout", "-q", "-b", "nowhere"], ["config", "branch.nowhere.remote", "nowhere"], ["config", "branch.nowhere.merge", "refs/heads/main"]],
      want: { state: "branch", ref: "refs/heads/nowhere", upstream: null, track: NONE },
    },
    "local-upstream": {
      setup: [["branch", "-q", "other", "HEAD~1"], ["checkout", "-q", "-b", "mine"], ["config", "branch.mine.remote", "."], ["config", "branch.mine.merge", "refs/heads/other"]],
      want: { state: "branch", ref: "refs/heads/mine", upstream: "refs/heads/other", track: counts(1, 0) },
    },
    detached: { setup: [], want: { state: "detached" } },
    "update-none": { setup: [TRACK_MAIN], want: onMain(counts(0, 0)) },
  } satisfies Record<string, Spec>;
  // Research.md R31: Git sets `%(upstream)` only for `refs/heads/` refs, also with `branch.v1.*` set.
  const TAG: Spec = {
    setup: [["tag", "v1"], ["symbolic-ref", "HEAD", "refs/tags/v1"], ["config", "branch.v1.remote", "origin"], ["config", "branch.v1.merge", "refs/heads/main"]],
    want: { state: "branch", ref: "refs/tags/v1", upstream: null, track: NONE },
  };

  function markWorld(name: string, specs: Record<string, Spec>): TreeWorld {
    const w = treeWorld(name, Object.fromEntries(Object.keys(specs).map((path) => [path, {}])));
    for (const [path, spec] of Object.entries(specs)) for (const args of spec.setup) treeGit(w, join(w.sup, path), args);
    return w;
  }
  const marksOf = (result: unknown) => valuesOf(result, "branches")[0] as Mark[] | undefined;
  // The mark of each row path, without its row ID. Each row has one mark at most.
  function markByPath(r: SubmoduleReview): Record<string, object> {
    const marks = marksOf(r.response.result) ?? [];
    expect(new Set(marks.map((m) => m.rowId)).size).toBe(marks.length);
    const pathOf = new Map(r.rows.map((row) => [row.rowId, row.path]));
    return Object.fromEntries(marks.map((m) => [pathOf.get(m.rowId) ?? `unknown row ${m.rowId}`, { ...m, rowId: undefined }]));
  }
  const inDir = (dir: string) => (c: Call) => {
    const at = gitLocation(c.arguments);
    return at !== null && relative(dir, resolve(dir, at)) === "";
  };
  const trackCallsIn = (service: Service, dir: string, from = 0) => callsSince(service, from).filter((c) => isTrackCall(c.arguments) && inDir(dir)(c));
  const allTrackCalls = (service: Service, from = 0) => callsSince(service, from).filter((c) => isTrackCall(c.arguments));

  const statusOf = (w: TreeWorld, dir: string) => treeGit(w, dir, ["-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"]);

  markCase("each mark equals the git status --porcelain=v2 --branch headers of its submodule, and a detached HEAD or a HEAD on a tag starts no mark read", async () => {
    const specs: Record<string, Spec> = { ...SPECS, tag: TAG };
    const w = markWorld("t139-marks", specs);
    treeGit(w, w.sup, ["config", "submodule.update-none.update", "none"]);
    await withTree(w, "t139-marks", async (service) => {
      const { r } = await reviewedTree(service, w);
      const marks = markByPath(r);
      const tracks = Object.fromEntries(Object.keys(specs).map((path) => [path, trackCallsIn(service, join(w.sup, path)).length]));
      const oracle: Record<string, object> = Object.fromEntries(Object.keys(SPECS).map((path) => [path, statusBranchMark(statusOf(w, join(w.sup, path)))]));
      const tag = join(w.sup, "tag");
      const tagStatus = statusOf(w, tag).split("\n").filter((l) => l.startsWith("# branch."));
      console.log(`OBSERVATION T139: a HEAD on refs/tags/v1 gives the status headers ${JSON.stringify(tagStatus)}`);
      // Research.md R31 is the oracle of the tag row: the HEAD target, and the `%(upstream)` of that ref.
      const upstream = treeGit(w, tag, ["for-each-ref", "--format=%(upstream)", "refs/tags/v1"]).trim() || null;
      oracle.tag = { state: "branch", ref: treeGit(w, tag, ["symbolic-ref", "HEAD"]).trim(), upstream, track: upstream === null ? NONE : { state: "unknown" } };
      expect({ outcome: outcome(r.response), mode: rowOf(r, "update-none").action }).toEqual({ outcome: SUCCEEDED, mode: "skip" });
      expect(marks).toEqual(Object.fromEntries(Object.entries(specs).map(([path, spec]) => [path, spec.want])));
      expect(Object.fromEntries(Object.entries(marks).map(([path, m]) => [path, shortUpstream(m)]))).toEqual(oracle);
      expect(tracks).toEqual(Object.fromEntries(Object.keys(specs).map((path) => [path, path === "detached" || path === "tag" ? 0 : 1])));
    });
  });

  markCase("a scoped review gives no mark and starts no mark read, and an initialized inactive row gives no mark", async () => {
    const w = markWorld("t139-scope", { equal: SPECS.equal, inactive: SPECS.equal });
    // Git's own `submodule update --init` sets `submodule.<name>.active = true`, which takes precedence over `submodule.active` (contract §12 "Plan", active set).
    treeGit(w, w.sup, ["config", "submodule.active", "equal"]);
    treeGit(w, w.sup, ["config", "submodule.inactive.active", "false"]);
    await withTree(w, "t139-scope", async (service) => {
      const { repositoryId, r } = await reviewedTree(service, w);
      expect({ outcome: outcome(r.response), inactive: rowOf(r, "inactive").action, marks: markByPath(r) }).toEqual({ outcome: SUCCEEDED, inactive: "skip", marks: { equal: SPECS.equal.want } });
      const read = await readOk(service, repositoryId);
      const from = service.runner.calls.length;
      const scoped = await service.request("reviewSubmodules", { snapshotId: read.snapshotId, scope: { path: "equal" } }, { repositoryId, repositoryGeneration: read.generation });
      expect({ outcome: outcome(scoped), branches: marksOf(scoped.result), tracks: allTrackCalls(service, from).length }).toEqual({ outcome: SUCCEEDED, branches: [], tracks: 0 });
    });
  });

  for (const [label, build, kinds] of [
    ["F27 base", (name: string) => buildF27(gitPath(), name, "base"), ["clone", "clone"]],
    ["F27 deinit-kept", (name: string) => buildF27(gitPath(), name, "deinit-kept"), ["clone", "reuse"]],
    ["F28 no-url", (name: string) => buildF28(gitPath(), name, "no-url"), ["clone", "clone", "no-url"]],
    ["F28 interrupted", (name: string) => buildF28(gitPath(), name, "interrupted"), ["clone", "clone-interrupted"]],
  ] as const) {
    markCase(`${label}: clone, reuse, no-URL, and clone-interrupted rows give no mark and start no mark read`, () => {
      const name = `t139-none-${label.replace(" ", "-").toLowerCase()}`;
      const b = build(name);
      return withFixture(b, name, async (service) => {
        const { r } = await reviewed(service, b);
        expect({ kinds: r.rows.map((row) => row.refusal ?? row.action).sort(), branches: marksOf(r.response.result), tracks: allTrackCalls(service).length }).toEqual({ kinds: [...kinds], branches: [], tracks: 0 });
      });
    });
  }

  markCase("a core.fsmonitor program of a submodule never runs during the review, and the submodule index keeps its bytes", async () => {
    const w = markWorld("t139-fsmonitor", { equal: SPECS.equal });
    const dir = join(w.sup, "equal");
    const marker = join(w.root, "fsmonitor.log");
    const script = put(w.root, "fsmonitor.sh", `#!/bin/sh\necho "fsmonitor $*" >> '${marker.replaceAll("\\", "/")}'\nexit 1\n`);
    treeGit(w, dir, ["config", "core.fsmonitor", `'${script.replaceAll("\\", "/")}'`]);
    const index = rawIndexDigest(gitPath(), dir);
    await withTree(w, "t139-fsmonitor", async (service) => {
      const { r } = await reviewedTree(service, w);
      expect({ outcome: outcome(r.response), ran: existsSync(marker), index: rawIndexDigest(gitPath(), dir), tracks: trackCallsIn(service, dir).length, marks: markByPath(r) }).toEqual({
        outcome: SUCCEEDED,
        ran: false,
        index,
        tracks: 1,
        marks: { equal: SPECS.equal.want },
      });
    });
  });

  // SC-018: git-for-each-ref(1) gives a ref whose tip is the commit as a ref that contains it.
  const fixCase = (name: string, fn: () => Promise<void>) => caseTest("T146", name, SHELL, fn, TIMEOUT_MS);
  const containsIn = (service: Service, dir: string) => callsSince(service).filter((c) => inDir(dir)(c) && commandOf(c.arguments)[1] === "--contains=HEAD");

  fixCase("a branch row at its HEAD commit starts no --contains read, so it starts as many Git processes as a detached row", async () => {
    const w = markWorld("t146-count", { onmain: SPECS.equal, detached: SPECS.detached });
    await withTree(w, "t146-count", async (service) => {
      const { r } = await reviewedTree(service, w);
      const per = (path: string) => {
        const dir = join(w.sup, path);
        return { processes: callsSince(service).filter(inDir(dir)).length, contains: containsIn(service, dir).length };
      };
      const got = { outcome: outcome(r.response), marks: markByPath(r), onmain: per("onmain"), detached: per("detached") };
      console.log(`OBSERVATION T146: ${JSON.stringify(got)}`);
      expect({ outcome: got.outcome, marks: got.marks, onmain: got.onmain.contains, detached: got.detached.contains }).toEqual({
        outcome: SUCCEEDED,
        marks: { onmain: SPECS.equal.want, detached: SPECS.detached.want },
        onmain: 0,
        detached: 1,
      });
      expect(got.onmain.processes).toBe(got.detached.processes);
    });
  });

  // The record names the HEAD branch with `*`, so the mark keeps its upstream and track. Only the object ID decides `held`.
  fixCase("a mark record with * at another object ID keeps the record mark and starts one --contains read", async () => {
    const w = markWorld("t146-moved", { onmain: SPECS.equal });
    const dir = join(w.sup, "onmain");
    const other = treeGit(w, dir, ["rev-parse", "HEAD~1"]).trim();
    await withTree(w, "t146-moved", async (service) => {
      service.runner.inject.stdout = (c) => (isTrackCall(c.arguments) && inDir(dir)(c) ? new TextEncoder().encode(`refs/heads/main\0${other}\0refs/remotes/origin/main\0ahead 5\0*\n`) : undefined);
      const { r } = await reviewedTree(service, w);
      expect({ outcome: outcome(r.response), marks: markByPath(r), contains: containsIn(service, dir).map((c) => c.exit?.exitCode ?? null) }).toEqual({
        outcome: SUCCEEDED,
        marks: { onmain: onMain(counts(5, 0)) },
        contains: [0],
      });
    });
  });

  const FAILURES: [label: string, code: string, arm: (service: Service, hit: (c: Call) => boolean) => void][] = [
    ["exit 128", "GIT_FAILED", (service, hit) => void (service.runner.inject.exit = (c) => (hit(c) ? 128 : undefined))],
    // `spawn` reads the injected deadline synchronously after the start check of each call.
    ["a 1 ms deadline", "DEADLINE", (service, hit) => void service.runner.holdStart((c) => ((service.runner.inject.deadlineMs = hit(c) ? 1 : null), false))],
    ["the stderr bound", "OUTPUT_LIMIT", (service, hit) => void (service.runner.inject.stderr = (c) => (hit(c) ? new Uint8Array(UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION) : undefined))],
    ["a runner refusal", "PROCESS_OWNERSHIP_FAILED", (service, hit) => void (service.runner.inject.refuse = (c) => (hit(c) ? "PROCESS_OWNERSHIP_FAILED" : undefined))],
  ];
  for (const [label, code, arm] of FAILURES) {
    // Contract §5 "Total unexpected diagnostic output": the 4 MiB bound counts per operation, so each later exit of the review carries `diagnosticLimit`.
    const bound = code === "OUTPUT_LIMIT";
    const end = bound ? "the --contains read after it, and the review fails OUTPUT_LIMIT" : `gives that row unread ${code}, one --contains read runs after it, and the review succeeds with every row and the other mark`;
    markCase(`${label} on the mark read of one row ${bound ? `carries over to ${end}` : end}`, async () => {
      const name = `t139-${code.toLowerCase().replaceAll("_", "-")}`;
      const w = markWorld(name, { ahead: SPECS.ahead, equal: SPECS.equal });
      await withTree(w, name, async (service) => {
        const dir = join(w.sup, "equal");
        arm(service, (c) => isTrackCall(c.arguments) && inDir(dir)(c));
        const { r } = await reviewedTree(service, w);
        const contains = containsIn(service, dir).map((c) => c.exit?.exitCode ?? null);
        expect({ outcome: outcome(r.response), rows: r.rows.map((row) => row.path), marks: markByPath(r), contains }).toEqual(
          bound
            ? { outcome: { state: "failed", code }, rows: [], marks: {}, contains: [0] }
            : { outcome: SUCCEEDED, rows: ["ahead", "equal"], marks: { ahead: SPECS.ahead.want, equal: { state: "unread", ref: "refs/heads/main", code } }, contains: [0] },
        );
      });
    });
  }

  // A held start, then a reply to an aborted or changed state.
  async function heldReview(service: Service, w: TreeWorld, dir: string, meanwhile: (requestId: string) => Promise<void>) {
    const { repositoryId } = await service.register(w.sup);
    await review();
    const read = await readOk(service, repositoryId);
    const isHeld = (c: Call) => isTrackCall(c.arguments) && inDir(dir)(c);
    const release = service.runner.holdStart(once(isHeld));
    const requestId = service.send("reviewSubmodules", { snapshotId: read.snapshotId }, { repositoryId, repositoryGeneration: read.generation });
    try {
      await until(() => service.runner.calls.some(isHeld) || service.responseAt.has(requestId), "held mark read", 30_000);
      expect(service.responseAt.has(requestId)).toBe(false);
      await meanwhile(requestId);
    } finally {
      release();
    }
    return service.response(requestId);
  }

  markCase("a branch switch while the mark read waits to start gives unread STATE_UNKNOWN, and the review succeeds", async () => {
    const w = markWorld("t139-held", { equal: SPECS.equal });
    const dir = join(w.sup, "equal");
    treeGit(w, dir, ["branch", "-q", "other"]);
    await withTree(w, "t139-held", async (service) => {
      const response = await heldReview(service, w, dir, async () => void treeGit(w, dir, ["symbolic-ref", "HEAD", "refs/heads/other"]));
      const rowId = objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"])[0]?.rowId;
      expect({ outcome: outcome(response), branches: marksOf(response.result) }).toEqual({ outcome: SUCCEEDED, branches: [{ rowId, state: "unread", ref: "refs/heads/main", code: "STATE_UNKNOWN" }] });
    });
  });

  markCase("Cancel while a mark read waits to start ends the review canceled", async () => {
    const w = markWorld("t139-cancel", { equal: SPECS.equal });
    await withTree(w, "t139-cancel", async (service) => {
      const response = await heldReview(service, w, join(w.sup, "equal"), async (requestId) => void (await service.cancel(await service.operationId(requestId))));
      expect({ state: response.state, branches: marksOf(response.result) }).toEqual({ state: "canceled", branches: undefined });
    });
  });

  markCase("a list review with marks, then Update, gives no changed-after-review, and the update starts no mark read", async () => {
    const w = markWorld("t139-update", { ahead: SPECS.ahead, detached: SPECS.detached, equal: SPECS.equal });
    await withTree(w, "t139-update", async (service) => {
      const { repositoryId, r } = await reviewedTree(service, w);
      expect({ outcome: outcome(r.response), marks: Object.keys(markByPath(r)).sort() }).toEqual({ outcome: SUCCEEDED, marks: ["ahead", "detached", "equal"] });
      await underTestSubmodule("submodule-update");
      const from = service.runner.calls.length;
      const updated = await updateSubmodules(service, repositoryId, r);
      expect({ outcome: outcome(updated), rows: resultsOf(updated).map((row) => [row.path, row.state, row.reason ?? null]), tracks: allTrackCalls(service, from).length }).toEqual({
        outcome: SUCCEEDED,
        rows: [["ahead", "moved", null], ["detached", "unchanged", null], ["equal", "unchanged", null]],
        tracks: 0,
      });
    });
  });

  describe("parallel reads (004 FR-112, contract Δ12 \"Parallel reads\", \"Review reads\", \"Kept-directory walk\")", () => {
    const parallelCase = (name: string, fn: () => Promise<void>) => caseTest("T148", name, SHELL, fn, TIMEOUT_MS);
    const firstRead = (c: Call) => commandOf(c.arguments).join(" ") === "rev-parse --verify -q HEAD";
    const isConfigList = (c: Call) => commandOf(c.arguments).join(" ") === "config list --show-scope --show-origin -z";
    // Rows a to l in index order: 10 checked-out rows with a URL, the row e without a .gitmodules entry, and the inactive row h.
    // a and g hold one nested row each. b and j are ahead 1, d holds an unsaved commit, and f has the update mode rebase. The kept Git directory of m has no row.
    const MARKED = ["a", "a/x", "b", "c", "d", "f", "g", "g/y", "i", "j", "k", "l"];
    const ROWS = ["a", "a/x", "b", "c", "d", "e", "f", "g", "g/y", "h", "i", "j", "k", "l"];
    let shared: TreeWorld | null = null;
    const world = (): TreeWorld => {
      if (shared !== null) return shared;
      const w = treeWorld("t148-parallel", { a: { x: {} }, b: {}, c: {}, d: {}, e: {}, f: {}, g: { y: {} }, h: {}, i: {}, j: {}, k: {}, l: {}, m: {} });
      const at = (path: string, args: string[]) => treeGit(w, join(w.sup, path), args);
      for (const path of ["a", "f", "i", "l"]) at(path, TRACK_MAIN);
      for (const path of ["b", "j"]) for (const args of SPECS.ahead.setup) at(path, args);
      at("d", ["commit", "-q", "--allow-empty", "-m", "unsaved"]);
      treeGit(w, w.sup, ["config", "submodule.f.update", "rebase"]);
      // Git's own update sets submodule.<name>.active=true, which takes precedence over submodule.active (contract §12 "Plan", active set).
      treeGit(w, w.sup, ["config", "submodule.active", "a"]);
      treeGit(w, w.sup, ["config", "submodule.h.active", "false"]);
      treeGit(w, w.sup, ["rm", "-q", "-f", "m"]);
      treeGit(w, w.sup, ["config", "--file", ".gitmodules", "--remove-section", "submodule.e"]);
      return (shared = w);
    };
    const at = (w: TreeWorld, path: string) => inDir(join(w.sup, ...path.split("/")));
    const callsOf = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);
    // The review reads of contract §12 "Review reads" run inside the submodules. The superproject trust listing runs its own reads in parallel.
    const insideOf = (w: TreeWorld, service: Service, operationId: string) => callsOf(service, operationId).filter((c) => insideSubmodule(w.sup, c.arguments));
    // The most calls that ran at the same time, from the start and the duration of each call.
    const peakOf = (calls: readonly { at: number; durationMs?: number }[]) => {
      const edges = calls.flatMap((c) => [[c.at, 1], [c.at + (c.durationMs ?? 0), -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let now = 0;
      let peak = 0;
      for (const [, step] of edges) peak = Math.max(peak, (now += step));
      return peak;
    };
    const pathMarks = (response: ServiceResponse) => markByPath({ response, rows: objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"]) } as SubmoduleReview);
    const markOracle = (w: TreeWorld, paths: readonly string[]) => Object.fromEntries(paths.map((path) => [path, statusBranchMark(statusOf(w, join(w.sup, ...path.split("/"))))]));
    const short = (marks: Record<string, object>) => Object.fromEntries(Object.entries(marks).map(([path, m]) => [path, shortUpstream(m)]));

    async function sendReview(service: Service, repositoryId: string, scope?: string): Promise<string> {
      const read = await readOk(service, repositoryId);
      return service.send("reviewSubmodules", { snapshotId: read.snapshotId, ...(scope === undefined ? {} : { scope: { path: scope } }) }, { repositoryId, repositoryGeneration: read.generation });
    }
    async function registered(service: Service, w: TreeWorld): Promise<string> {
      await review();
      return (await service.register(w.sup)).repositoryId;
    }

    // `siblingDeadline` of service-harness.ts with several siblings: the target starts after every sibling started, with a 1 ms deadline.
    // Each sibling gets one stdout byte that its paused stdout holds, so only the Job close ends it, with `exitCode` null and no `deadline`.
    function siblingsDeadline(service: Service, target: (c: Call) => boolean, siblings: ((c: Call) => boolean)[]): () => void {
      const { runner } = service;
      const isTarget = once(target);
      const held = siblings.map((s) => once(s));
      const started = new Set<readonly string[]>();
      const answered = new Set<readonly string[]>();
      let armed = true;
      const releaseTarget = runner.holdStart(isTarget);
      const releaseHook = runner.holdStart((call) => {
        if (held.some((isSibling) => isSibling(call)) && !started.has(call.arguments)) {
          started.add(call.arguments);
          if (started.size === held.length) releaseTarget();
        } else if (started.size === held.length && armed && isTarget(call)) {
          armed = false;
          // `spawn` reads the deadline synchronously after this check. The reset keeps every later process at its request deadline.
          runner.inject.deadlineMs = 1;
          queueMicrotask(() => void (runner.inject.deadlineMs = null));
        }
        return false;
      });
      const resumes = held.map((isSibling) => runner.pauseStdout(isSibling));
      const prior = runner.inject.stdout;
      runner.inject.stdout = (call) => {
        if (!started.has(call.arguments) || answered.has(call.arguments)) return prior?.(call);
        answered.add(call.arguments);
        return new Uint8Array([0]);
      };
      return () => {
        releaseTarget();
        releaseHook();
        for (const resume of resumes) resume();
        runner.inject.stdout = prior;
      };
    }

    parallelCase("rows, row order, refusals, and marks equal those of a one-at-a-time review, and Update with the token passes its one-at-a-time preflight", async () => {
      const w = world();
      const head = (path: string) => treeGit(w, join(w.sup, path), ["rev-parse", "HEAD"]).trim();
      const target = (path: string) => treeGit(w, w.sup, ["ls-files", "-s", "--", path]).split(" ")[1]!;
      const none = (path: string, depth = 0, parent: string | null = null) => [path, depth, parent, "none", null, []];
      const expected = [
        none("a"),
        none("a/x", 1, "a"),
        ["b", 0, null, "checkout", null, [NOTES.detaches("main"), NOTES.moves(head("b"), target("b"))]],
        none("c"),
        ["d", 0, null, "checkout", "unsaved-commits", [NOTES.moves(head("d"), target("d"))]],
        ["e", 0, null, "clone", "no-url", []],
        ["f", 0, null, "none", "update-mode", []],
        none("g"),
        none("g/y", 1, "g"),
        ["h", 0, null, "skip", null, []],
        none("i"),
        ["j", 0, null, "checkout", null, [NOTES.detaches("main"), NOTES.moves(head("j"), target("j"))]],
        none("k"),
        none("l"),
      ];
      await withTree(w, "t148-order", async (service) => {
        const { r } = await reviewedTree(service, w);
        const pathOf = new Map(r.rows.map((row) => [row.rowId, row.path]));
        const rows = r.rows.map((row) => [row.path, row.depth, row.parentRowId === null ? null : (pathOf.get(row.parentRowId) ?? "unknown"), row.action, row.refusal, row.notes]);
        expect({ outcome: outcome(r.response), rows, refusals: r.refusals.map((x) => [x.reason, x.path]), hosts: valuesOf(r.response.result, "hosts")[0] }).toEqual({
          outcome: SUCCEEDED,
          rows: expected,
          // Contract §12 "Refusals": the update-mode refusal comes after the others. A tail refusal of d comes before the check refusal of e.
          refusals: [["unsaved-commits", "d"], ["no-url", "e"], ["update-mode", "f"]],
          hosts: [],
        });
        expect(short(pathMarks(r.response))).toEqual(markOracle(w, MARKED));
      });
      // Contract §12 "Update protocol" step 2: a review refusal refuses the update before its preflight, so a copy drops the refusals first.
      const copy = join(w.root, "t148-copy");
      cpSync(w.sup, copy, { recursive: true });
      treeGit(w, copy, ["checkout", "-q", "--", ".gitmodules"]);
      treeGit(w, join(copy, "d"), ["branch", "-q", "saved"]);
      treeGit(w, copy, ["config", "--unset", "submodule.f.update"]);
      await withTree(w, "t148-order-update", async (service) => {
        await review();
        const { repositoryId } = await service.register(copy);
        const r = await reviewSubmodules(service, repositoryId);
        expect({ outcome: outcome(r.response), refusals: r.refusals.map((x) => x.reason), rows: r.rows.map((row) => row.path) }).toEqual({ outcome: SUCCEEDED, refusals: [], rows: ROWS });
        await underTestSubmodule("submodule-update");
        // The preflight observer reads one row at a time, so another order or another observed value gives STALE_REVIEW.
        const updated = await updateSubmodules(service, repositoryId, r);
        expect({ outcome: outcome(updated), rows: resultsOf(updated).map((row) => [row.path, row.state]) }).toEqual({
          outcome: SUCCEEDED,
          rows: ROWS.map((path) => [path, ["b", "d", "j"].includes(path) ? "moved" : "unchanged"]),
        });
      });
    });

    parallelCase("the list review runs at least 2 and at most 9 review Git processes at once, and a scoped review runs 1", async () => {
      const w = world();
      await withTree(w, "t148-lanes", async (service) => {
        const repositoryId = await registered(service, w);
        const list = await sendReview(service, repositoryId);
        const listed = await service.response(list, NO_TOTAL_DEADLINE_WAIT_MS);
        const listPeak = peakOf(insideOf(w, service, await service.operationId(list)));
        const scoped = await sendReview(service, repositoryId, "a");
        const scopedOutcome = outcome(await service.response(scoped, NO_TOTAL_DEADLINE_WAIT_MS));
        const scopedPeak = peakOf(insideOf(w, service, await service.operationId(scoped)));
        console.log(`OBSERVATION T148: peak list ${listPeak}, peak scoped ${scopedPeak}`);
        expect({ list: outcome(listed), scoped: scopedOutcome, listAtLeast2: listPeak >= 2, listAtMost9: listPeak <= 9, scopedPeak }).toEqual({ list: SUCCEEDED, scoped: SUCCEEDED, listAtLeast2: true, listAtMost9: true, scopedPeak: 1 });
      });
    });

    parallelCase("a 1 ms deadline on the mark read of row 0 gives unread DEADLINE; each held read of three other rows ends with exit code null and runs once more, and the list succeeds", async () => {
      const w = world();
      await withTree(w, "t148-mark-deadline", async (service) => {
        const repositoryId = await registered(service, w);
        const release = siblingsDeadline(service, (c) => isTrackCall(c.arguments) && at(w, "a")(c), ["b", "c", "d"].map((path) => (c: Call) => at(w, path)(c) && firstRead(c)));
        let response: ServiceResponse;
        try {
          response = await service.response(await sendReview(service, repositoryId), NO_TOTAL_DEADLINE_WAIT_MS);
        } finally {
          release();
        }
        const held = ["b", "c", "d"].map((path) => callsSince(service).filter((c) => at(w, path)(c) && firstRead(c)).map((c) => [c.exit?.exitCode ?? null, c.exit?.deadline ?? null]));
        const marks = short(pathMarks(response));
        expect({ outcome: outcome(response), rows: objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"]).map((row) => row.path), held, a: marks.a }).toEqual({
          outcome: SUCCEEDED,
          rows: ROWS,
          held: [0, 1, 2].map(() => [[null, null], [0, null]]),
          a: { state: "unread", ref: "refs/heads/main", code: "DEADLINE" },
        });
        expect({ ...marks, a: undefined }).toEqual({ ...markOracle(w, MARKED), a: undefined });
      });
    });

    parallelCase("one recorded deadline closes the Job while 8 reads run: each other read runs again once, and a rerun that ends with exit code null without a new deadline runs no third time", async () => {
      const w = world();
      const siblings = ["b", "c", "d", "f", "g", "i", "j"];
      await withTree(w, "t148-rerun-once", async (service) => {
        const repositoryId = await registered(service, w);
        const release = siblingsDeadline(service, (c) => isTrackCall(c.arguments) && at(w, "a")(c), siblings.map((path) => (c: Call) => at(w, path)(c) && firstRead(c)));
        // The second start of the first read of b ends with exit code null, and no read records a second deadline.
        let starts = 0;
        service.runner.inject.exit = (c) => (at(w, "b")(c) && firstRead(c) && ++starts === 2 ? null : undefined);
        let response: ServiceResponse;
        try {
          response = await service.response(await sendReview(service, repositoryId), NO_TOTAL_DEADLINE_WAIT_MS);
        } finally {
          release();
        }
        const exits = (path: string, match: (c: Call) => boolean) => callsSince(service).filter((c) => at(w, path)(c) && match(c)).map((c) => [c.exit?.exitCode ?? null, c.exit?.deadline ?? null]);
        // Contract §6 `exit`: the read of b has no exit code, so its row fails with GIT_FAILED.
        expect({ outcome: outcome(response), target: exits("a", (c) => isTrackCall(c.arguments)), held: Object.fromEntries(siblings.map((path) => [path, exits(path, firstRead)])) }).toEqual({
          outcome: { state: "failed", code: "GIT_FAILED" },
          target: [[null, "deadline"]],
          held: Object.fromEntries(siblings.map((path) => [path, [[null, null], path === "b" ? [null, null] : [0, null]]])),
        });
      });
    });

    parallelCase("a 1 ms deadline on the config list of row 5 fails the review with DEADLINE, and no review process ends after the response", async () => {
      const w = world();
      await withTree(w, "t148-deadline", async (service) => {
        const { runner } = service;
        const repositoryId = await registered(service, w);
        const isTarget = once((c) => at(w, "f")(c) && isConfigList(c));
        // The read of the last row waits to start until the test releases it. A review that waits for its reads cannot answer before that.
        const isLate = once((c) => at(w, "l")(c) && firstRead(c));
        let armed = true;
        const releaseTarget = runner.holdStart(isTarget);
        const releaseLate = runner.holdStart(isLate);
        const releaseHook = runner.holdStart((call) => {
          if (armed && isTarget(call)) {
            armed = false;
            runner.inject.deadlineMs = 1;
            queueMicrotask(() => void (runner.inject.deadlineMs = null));
          }
          return false;
        });
        let requestId = "";
        let response: ServiceResponse;
        try {
          requestId = await sendReview(service, repositoryId);
          await until(() => runner.calls.some((c) => at(w, "l")(c) && firstRead(c)), "the read of row l", 60_000);
          releaseTarget();
          await until(() => runner.calls.some((c) => at(w, "f")(c) && isConfigList(c) && c.exit !== undefined), "the deadline of row f", 30_000);
          for (const end = performance.now() + 3_000; !service.responseAt.has(requestId) && performance.now() < end; ) await Bun.sleep(20);
          releaseLate();
          response = await service.response(requestId, NO_TOTAL_DEADLINE_WAIT_MS);
        } finally {
          releaseTarget();
          releaseLate();
          releaseHook();
        }
        const end = service.responseAt.get(requestId)!;
        const calls = callsOf(service, await service.operationId(requestId));
        const late = calls.filter((c) => c.durationMs === undefined || c.at + c.durationMs > end).map((c) => commandOf(c.arguments).join(" "));
        const deadline = calls.filter((c) => at(w, "f")(c) && isConfigList(c)).map((c) => c.exit?.deadline ?? null);
        expect({ outcome: outcome(response), late, deadline }).toEqual({ outcome: { state: "failed", code: "DEADLINE" }, late: [], deadline: ["deadline"] });
      });
    });

    parallelCase("Cancel while 8 reads run ends the review canceled; no review process starts after Cancel or ends after the response", async () => {
      const w = world();
      await withTree(w, "t148-cancel", async (service) => {
        const repositoryId = await registered(service, w);
        const held = new Set<object>();
        const dirs = new Set<string>();
        const resume = service.runner.pauseStdout((c) => {
          if (held.has(c)) return true;
          const where = gitLocation(c.arguments);
          if (where === null || !insideSubmodule(w.sup, c.arguments) || !firstRead(c) || dirs.size >= 8 || dirs.has(where)) return false;
          dirs.add(where);
          held.add(c);
          return true;
        });
        let requestId = "";
        let canceledAt = 0;
        let response: ServiceResponse;
        try {
          requestId = await sendReview(service, repositoryId);
          await until(() => held.size === 8, "8 held reads", 60_000);
          canceledAt = performance.now();
          await service.cancel(await service.operationId(requestId));
          response = await service.response(requestId, NO_TOTAL_DEADLINE_WAIT_MS);
        } finally {
          resume();
        }
        const end = service.responseAt.get(requestId)!;
        const calls = callsOf(service, await service.operationId(requestId));
        expect({
          state: response.state,
          held: held.size,
          started: calls.filter((c) => c.at > canceledAt).length,
          late: calls.filter((c) => c.durationMs === undefined || c.at + c.durationMs > end).length,
        }).toEqual({ state: "canceled", held: 8, started: 0, late: 0 });
      });
    });

    parallelCase("4 MiB of stderr on one read of row 3 fails the review with OUTPUT_LIMIT", async () => {
      const w = world();
      await withTree(w, "t148-stderr", async (service) => {
        const repositoryId = await registered(service, w);
        const hit = once((c) => at(w, "d")(c) && isConfigList(c));
        service.runner.inject.stderr = (c) => (hit(c) ? new Uint8Array(UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION) : undefined);
        const response = await service.response(await sendReview(service, repositoryId), NO_TOTAL_DEADLINE_WAIT_MS);
        expect(outcome(response)).toEqual({ state: "failed", code: "OUTPUT_LIMIT" });
      });
    });

    parallelCase("a branch row at its HEAD commit and a detached row each start 7 Git processes; one rev-parse prints the Git directory and the hooks path, and a relative core.hooksPath keeps its hook and digest", async () => {
      const w = treeWorld("t148-processes", { detached: {}, onmain: {} });
      const onmain = join(w.sup, "onmain");
      treeGit(w, onmain, TRACK_MAIN);
      treeGit(w, onmain, ["config", "core.hooksPath", ".hooks"]);
      const hook = put(onmain, ".hooks/post-checkout", "#!/bin/sh\nexit 0\n");
      await withTree(w, "t148-processes", async (service) => {
        const { r } = await reviewedTree(service, w);
        const per = (path: string) => callsSince(service).filter(at(w, path));
        // The `-C` value is the row folder. Every other argument is exact.
        const paths = (path: string) => per(path).filter((c) => commandOf(c.arguments)[1] === "--absolute-git-dir").map((c) => c.arguments.map((a, i) => (i === 3 ? relative(join(w.sup, path), a) : a)));
        const row = rowOf(r, "onmain");
        const hooks = r.programs.filter((p) => "rowId" in p && p.rowId === row.rowId && p.scope === "hooks").map((p) => ({ key: p.key, at: relative(hook, p.program), digest: p.digest }));
        const got = { outcome: outcome(r.response), onmain: per("onmain").length, detached: per("detached").length, paths: [paths("onmain"), paths("detached")], hooks };
        console.log(`OBSERVATION T148: ${JSON.stringify({ onmain: per("onmain").map((c) => commandOf(c.arguments).slice(0, 2).join(" ")), detached: per("detached").map((c) => commandOf(c.arguments).slice(0, 2).join(" ")) })}`);
        const merged = ["--no-lazy-fetch", "--no-optional-locks", "-C", "", "--git-dir=.git", "rev-parse", "--absolute-git-dir", "--git-path", "hooks"];
        expect(got).toEqual({ outcome: SUCCEEDED, onmain: 7, detached: 7, paths: [[merged], [merged]], hooks: [{ key: "post-checkout", at: "", digest: fileSha256(hook) }] });
      });
    });

    parallelCase("the kept-directory walk starts no rev-parse in a row Git directory, and a kept directory without a row keeps its read, its programs, and its refusals", async () => {
      const w = treeWorld("t148-walk", { a: { x: {} }, b: {}, m: {} });
      const gitDirOf = (dir: string) => resolve(treeGit(w, dir, ["rev-parse", "--absolute-git-dir"]).trim());
      const m = join(w.sup, "m");
      treeGit(w, m, ["commit", "-q", "--allow-empty", "-m", "unsaved"]);
      treeGit(w, m, ["config", "submodule.z.gitdir", "elsewhere"]);
      const kept = gitDirOf(m);
      treeGit(w, w.sup, ["rm", "-q", "-f", "m"]);
      const rowDirs = ["a", "a/x", "b"].map((path) => gitDirOf(join(w.sup, ...path.split("/"))));
      await withTree(w, "t148-walk", async (service) => {
        const { r } = await reviewedTree(service, w);
        // The commands that name `dir` with `--git-dir=`.
        const reads = (dir: string) =>
          callsSince(service)
            .filter((c) => c.arguments.some((a) => a.startsWith("--git-dir=") && a !== "--git-dir=.git" && relative(dir, a.slice("--git-dir=".length)) === ""))
            .map((c) => commandOf(c.arguments).join(" "));
        expect({
          outcome: outcome(r.response),
          rowWalks: rowDirs.map((dir) => reads(dir)),
          kept: reads(kept).filter((c) => c.startsWith("rev-parse --absolute-git-dir")),
          programs: r.programs.some((p) => "gitDirectory" in p && relative(kept, p.gitDirectory) === ""),
          refusals: r.refusals.map((x) => [x.reason, relative(kept, x.path)]),
        }).toEqual({
          outcome: SUCCEEDED,
          rowWalks: [[], [], []],
          kept: ["rev-parse --absolute-git-dir", "rev-parse --absolute-git-dir --git-path hooks"],
          programs: true,
          refusals: [["unsaved-commits", ""], ["gitdir-config", ""]],
        });
      });
    });
  });
});

// ---- Feature 004 FR-114: each submodule counts once (T156, contract Δ12 "Submodule count", "Kept-directory walk") ----

// Adds the `flatWorld` gitlinks `from` to `to - 1` without a clone, to `.gitmodules` and to the index at `w.leaf.second`. The function that it gives removes them again.
function addUncloned(w: TreeWorld, from: number, to: number): () => void {
  const list = Array.from({ length: to - from }, (_, k) => from + k);
  const g = (args: string[], input?: string) => ownedGit(gitPath(), FIXTURE_ROOT, w.sup, args, { env: w.env, ...(input === undefined ? {} : { input: Buffer.from(input) }) });
  appendFileSync(join(w.sup, ".gitmodules"), list.map((i) => `[submodule "${flatName(i)}"]\n\tpath = ${countPath(i)}\n\turl = ../leaf.git\n`).join(""));
  g(["update-index", "--add", "--", ".gitmodules"]);
  g(["update-index", "-z", "--index-info"], list.map((i) => `160000 ${w.leaf.second} 0\t${countPath(i)}\0`).join(""));
  return () => {
    g(["update-index", "--force-remove", "-z", "--stdin"], list.map((i) => `${countPath(i)}\0`).join(""));
    g(["checkout", "-q", "HEAD", "--", ".gitmodules"]);
  };
}

describe("submodule count (004 FR-114, contract Δ12 \"Submodule count\", \"Kept-directory walk\")", () => {
  const MINUTE_MS = 60_000;
  const countCase = (name: string, fn: () => Promise<void>, minutes = 10) => caseTest("T156", name, SHELL, fn, minutes * MINUTE_MS);
  // Contract §5 "Ordinary read deadline": `updateSubmodules` has no total read deadline. This wait is a test budget.
  const UPDATE_WAIT_MS = 15 * MINUTE_MS;
  let flatShared: TreeWorld | null = null;
  let folderShared: TreeWorld | null = null;
  const flat = () => (flatShared ??= flatWorld("t156-flat", 256));
  const folders = () => (folderShared ??= folderWorld("t156-folders", 256));
  const modulesOf = (w: TreeWorld) => join(w.sup, ".git", "modules");
  const leafUrl = (w: TreeWorld) => join(w.root, "leaf.git").replaceAll("\\", "/");
  // The walk read of contract §12 "Review reads": `--git-dir=<folder> --work-tree=<folder> rev-parse --absolute-git-dir`, as [folder below `modules`, accepted].
  const walkReads = (service: Service, from: number, modules: string) =>
    callsSince(service, from)
      .filter((c) => commandOf(c.arguments).join(" ") === "rev-parse --absolute-git-dir")
      .map((c): [string, boolean] => [relative(modules, resolve(modules, gitLocation(c.arguments)!)).replaceAll("\\", "/"), c.exit?.exitCode === 0]);
  // git-submodule(1) `status`: a leading space means that the checked-out commit equals the recorded commit.
  const statusLines = (w: TreeWorld) => treeGit(w, w.sup, ["submodule", "status", "--recursive"]).split("\n").filter((line) => line !== "");
  const limitTexts = (r: SubmoduleReview) => r.refusals.filter((x) => x.reason === "limit").map((x) => x.text);
  async function scopedReview(service: Service, repositoryId: string, path: string): Promise<SubmoduleReview> {
    const read = await readOk(service, repositoryId);
    const response = await service.request("reviewSubmodules", { snapshotId: read.snapshotId, scope: { path } }, { repositoryId, repositoryGeneration: read.generation });
    return {
      read,
      response,
      token: valuesOf(response.result, "submoduleReviewToken")[0] as string | undefined,
      rows: objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"]),
      programs: [],
      refusals: refusalsOf(response.result),
    };
  }

  countCase(
    "case 1: 256 cloned rows with flat names give no refusal and a token, and the update leaves every row unchanged",
    async () => {
      const w = flat();
      const before = statusLines(w);
      await withService({ name: "t156-flat-update", environment: serviceEnv(w.env) }, async (service) => {
        const { repositoryId, r } = await reviewedTree(service, w);
        expect({ outcome: outcome(r.response), rows: r.rows.length, refusals: r.refusals.map((x) => [x.reason, x.path]), token: typeof r.token, actions: [...new Set(r.rows.map((row) => row.action))] }).toEqual({
          outcome: SUCCEEDED,
          rows: 256,
          refusals: [],
          token: "string",
          actions: ["none"],
        });
        await underTestSubmodule("submodule-update");
        const updated = await service.response(sendUpdate(service, repositoryId, r), UPDATE_WAIT_MS);
        const states = resultsOf(updated).map((row) => row.state);
        expect({ outcome: outcome(updated), rows: states.length, changed: states.filter((s) => s !== "unchanged") }).toEqual({ outcome: SUCCEEDED, rows: 256, changed: [] });
      });
      const after = statusLines(w);
      expect({ rows: before.length, moved: before.filter((line) => !line.startsWith(" ")), after }).toEqual({ rows: 256, moved: [], after: before });
    },
    25,
  );

  // C2: a prefix match takes `modules/s0001` for the Git directory of row `s000`. The 256 cloned rows keep their Git directories for it.
  // T160 (FR-115): the 768 rows without a clone fill the bound of 1,024.
  for (const rowless of ["old", "s0001"]) {
    countCase(`case 2a: 256 cloned flat rows, 768 rows without a clone, and the kept Git directory modules/${rowless} without a row give limit`, async () => {
      const w = flat();
      const kept = join(modulesOf(w), rowless);
      if (rowless === "s0001") expect(flatName(0)).toBe("s000");
      treeGit(w, w.root, ["clone", "-q", "--bare", leafUrl(w), kept]);
      const remove = addUncloned(w, 256, 1_024);
      try {
        await withTree(w, `t156-rowless-${rowless}`, async (service) => {
          const { r } = await reviewedTree(service, w);
          expect({ outcome: outcome(r.response), rows: r.rows.length, limit: limitTexts(r) }).toEqual({ outcome: SUCCEEDED, rows: 1_024, limit: [TEXTS.limit] });
        });
      } finally {
        remove();
        removeTree(kept);
      }
    });
  }

  countCase("case 2b: 256 cloned flat rows and 769 rows without a clone give limit", async () => {
    const w = flat();
    const remove = addUncloned(w, 256, 1_025);
    try {
      await withTree(w, "t156-flat-1025", async (service) => {
        const { r } = await reviewedTree(service, w);
        expect({ outcome: outcome(r.response), rows: r.rows.length, limit: limitTexts(r) }).toEqual({ outcome: SUCCEEDED, rows: 1_025, limit: [TEXTS.limit] });
      });
    } finally {
      remove();
    }
  });

  // T160 (FR-115): the 768 rows without a clone fill the bound of 1,024, so a second count of a row Git directory or a name folder gives limit.
  countCase("case 2c: 256 cloned rows whose names equal their paths and 768 rows without a clone give no refusal: the 17 name folders that Git does not accept do not count", async () => {
    const w = folders();
    const remove = addUncloned(w, 256, 1_024);
    try {
      await withTree(w, "t156-folders", async (service) => {
        const { r } = await reviewedTree(service, w);
        expect({ outcome: outcome(r.response), rows: r.rows.length, refusals: r.refusals.map((x) => [x.reason, x.path]), token: typeof r.token }).toEqual({ outcome: SUCCEEDED, rows: 1_024, refusals: [], token: "string" });
      });
    } finally {
      remove();
    }
  });

  // T160 (FR-115): the 768 rows without a clone fill the bound of 1,024.
  countCase("case 2d: a name folder that Git accepts as a Git directory counts, so 256 rows with names equal to their paths and 768 rows without a clone give limit", async () => {
    const w = folders();
    const name = join(modulesOf(w), "m", "00");
    const had = new Set(readdirSync(name));
    treeGit(w, w.root, ["init", "-q", "--bare", "-b", "main", name]);
    const remove = addUncloned(w, 256, 1_024);
    try {
      await withTree(w, "t156-folders-accepted", async (service) => {
        const from = callsSince(service).length;
        const { r } = await reviewedTree(service, w);
        expect({ outcome: outcome(r.response), rows: r.rows.length, limit: limitTexts(r), read: walkReads(service, from, modulesOf(w)).filter(([folder]) => folder === "m/00") }).toEqual({
          outcome: SUCCEEDED,
          rows: 1_024,
          limit: [TEXTS.limit],
          read: [["m/00", true]],
        });
      });
    } finally {
      remove();
      for (const entry of readdirSync(name)) if (!had.has(entry)) removeTree(join(name, entry));
    }
  });

  countCase("case 3: the walk reads no row Git directory, and it reads each name folder and the kept Git directory without a row; the update takes the token", async () => {
    const w = folderWorld("t156-walk", 20);
    treeGit(w, w.root, ["clone", "-q", "--bare", leafUrl(w), join(modulesOf(w), "old")]);
    // The review lists the rows in index order, which sorts the path bytes.
    const paths = Array.from({ length: 20 }, (_, i) => countPath(i)).sort();
    const groups = Array.from({ length: 16 }, (_, g) => `m/${String(g).padStart(2, "0")}`);
    await withTree(w, "t156-walk", async (service) => {
      const from = callsSince(service).length;
      const { repositoryId, r } = await reviewedTree(service, w);
      const reads = walkReads(service, from, modulesOf(w));
      expect({ outcome: outcome(r.response), rows: r.rows.map((row) => [row.path, row.action]), refusals: r.refusals.map((x) => [x.reason, x.path]), reads }).toEqual({
        outcome: SUCCEEDED,
        rows: paths.map((path) => [path, "none"]),
        refusals: [],
        reads: [["m", false], ...groups.map((g): [string, boolean] => [g, false]), ["old", true]],
      });
      // The preflight observer walks again, so another walk value gives STALE_REVIEW.
      await underTestSubmodule("submodule-update");
      const updated = await updateSubmodules(service, repositoryId, r);
      expect({ outcome: outcome(updated), rows: resultsOf(updated).map((row) => [row.path, row.state]) }).toEqual({ outcome: SUCCEEDED, rows: paths.map((path) => [path, "unchanged"]) });
    });
  });

  // C3: a match by the folded key takes `modules/S000` for the Git directory of row `s000`.
  countCase("case 3b: a kept Git directory without a row, whose name differs from a row Git directory only in letter case, gets its read and its refusal", async () => {
    let sensitive = false;
    const w = flatWorld("t156-case", 1, {
      beforeInit: (sup) => {
        const modules = join(sup, ".git", "modules");
        mkdirSync(modules);
        if (process.platform === "win32") Bun.spawnSync(["fsutil", "file", "setCaseSensitiveInfo", modules, "enable"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        // OS fact: a folder that ignores letter case refuses a second name that differs only in letter case with EEXIST.
        mkdirSync(join(modules, "probe"));
        try {
          mkdirSync(join(modules, "PROBE"));
          sensitive = true;
          rmdirSync(join(modules, "PROBE"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        rmdirSync(join(modules, "probe"));
      },
    });
    if (!sensitive) {
      console.log("SKIP T156 case 3b: fsutil file setCaseSensitiveInfo did not make the modules folder case-sensitive");
      return;
    }
    const kept = join(modulesOf(w), flatName(0).toUpperCase());
    treeGit(w, w.root, ["clone", "-q", "--bare", leafUrl(w), kept]);
    treeGit(w, w.root, [`--git-dir=${kept}`, "config", "submodule.z.gitdir", "elsewhere"]);
    expect(readdirSync(modulesOf(w)).sort()).toEqual(["S000", "s000"]);
    await withTree(w, "t156-case", async (service) => {
      const from = callsSince(service).length;
      const { r } = await reviewedTree(service, w);
      expect({
        outcome: outcome(r.response),
        refusals: r.refusals.map((x) => [x.reason, relative(modulesOf(w), dirname(x.path)), basename(x.path)]),
        reads: walkReads(service, from, modulesOf(w)).map(([folder, accepted]) => [basename(folder), accepted]),
      }).toEqual({ outcome: SUCCEEDED, refusals: [["gitdir-config", "", "S000"]], reads: [["S000", true]] });
    });
  });

  countCase("case 5: a scoped review of one row of 256 cloned flat rows gives that row without a refusal, and its update leaves it unchanged", async () => {
    const w = flat();
    const path = countPath(100);
    await withTree(w, "t156-scoped", async (service) => {
      await review();
      const { repositoryId } = await service.register(w.sup);
      const r = await scopedReview(service, repositoryId, path);
      expect({ outcome: outcome(r.response), rows: r.rows.map((row) => [row.path, row.action]), refusals: r.refusals.map((x) => x.reason), token: typeof r.token }).toEqual({
        outcome: SUCCEEDED,
        rows: [[path, "none"]],
        refusals: [],
        token: "string",
      });
      await underTestSubmodule("submodule-update");
      const updated = await updateSubmodules(service, repositoryId, r);
      expect({ outcome: outcome(updated), rows: resultsOf(updated).map((row) => [row.path, row.state]) }).toEqual({ outcome: SUCCEEDED, rows: [[path, "unchanged"]] });
    });
  });

  // FR-112, contract Δ12 "Parallel reads": the shell walks of the program listing (001 §6 "Walks") start no Git process, so the case counts `listSubmoduleTrust` calls.
  countCase("case 6: the program listing of the list review runs at most 8 rows at once and applies in row order; the programs and their digest equal those of one row at a time", async () => {
    const w = flatWorld("t156-listing", 20);
    // The review lists the rows in index order, which sorts the path bytes.
    const paths = Array.from({ length: 20 }, (_, i) => countPath(i)).sort();
    for (const path of paths) treeGit(w, join(w.sup, ...path.split("/")), ["config", "arbareto.row", path]);
    const real = trustModule.listSubmoduleTrust;
    let serial = false;
    let started = 0;
    let live = 0;
    let peak = 0;
    let turn: Promise<void> = Promise.resolve();
    const listing = spyOn(trustModule, "listSubmoduleTrust").mockImplementation(async (...args: Parameters<typeof real>) => {
      const index = started++;
      let release = () => {};
      const prior = turn;
      if (serial) {
        turn = new Promise((resolve) => (release = resolve));
        await prior;
      }
      live++;
      peak = Math.max(peak, live);
      try {
        // A later listing ends first, so only the apply order keeps the row order.
        if (!serial) await Bun.sleep(4 * (24 - (index % 24)));
        return await real(...args);
      } finally {
        live--;
        release();
      }
    });
    const bindings: approvalsModule.SubmoduleBinding[] = [];
    const create = approvalsModule.createApprovals;
    const approvals = spyOn(approvalsModule, "createApprovals").mockImplementation((now) => {
      const store = create(now);
      const issue = store.issue;
      store.issue = (approval) => {
        if (approval.kind === "submodule") bindings.push(approval.binding);
        return issue(approval);
      };
      return store;
    });
    try {
      await withTree(w, "t156-listing", async (service) => {
        await review();
        const { repositoryId } = await service.register(w.sup);
        const listed = async () => {
          started = 0;
          peak = 0;
          const r = await reviewSubmodules(service, repositoryId);
          const pathOf = new Map(r.rows.map((row) => [row.rowId, row.path]));
          return { r, calls: started, peak, programs: r.programs.map((p) => ({ ...p, rowId: "rowId" in p ? pathOf.get(p.rowId) : undefined })) };
        };
        const ahead = await listed();
        serial = true;
        const oneByOne = await listed();
        console.log(`OBSERVATION T156: listing peak ${ahead.peak}, one by one ${oneByOne.peak}`);
        expect({
          outcome: outcome(ahead.r.response),
          calls: ahead.calls,
          atLeast2: ahead.peak >= 2,
          atMost8: ahead.peak <= 8,
          oneByOne: oneByOne.peak,
          order: ahead.programs.map((p) => [p.rowId, p.key]),
          programs: ahead.programs,
          digests: bindings.map((b) => b.programs),
        }).toEqual({
          outcome: SUCCEEDED,
          calls: 20,
          atLeast2: true,
          atMost8: true,
          oneByOne: 1,
          order: paths.map((path) => [path, "arbareto.row"]),
          programs: oneByOne.programs,
          digests: [bindings[0]!.programs, bindings[0]!.programs],
        });
        // The preflight observer lists one row at a time, so another program digest gives STALE_REVIEW.
        await underTestSubmodule("submodule-update");
        const updated = await updateSubmodules(service, repositoryId, ahead.r);
        expect({ outcome: outcome(updated), rows: resultsOf(updated).map((row) => [row.path, row.state]) }).toEqual({ outcome: SUCCEEDED, rows: paths.map((path) => [path, "unchanged"]) });
      });
    } finally {
      listing.mockRestore();
      approvals.mockRestore();
    }
  });

  countCase("case 7: deep names give 1,025 name folders; the review refuses with limit, and no walk read starts past the 1,024th name folder", async () => {
    const { world: w, names } = deepWorld("t156-deep");
    const folderOf = (name: string, levels: number) => name.split("/").slice(0, levels).join("/");
    await withTree(w, "t156-deep", async (service) => {
      const from = callsSince(service).length;
      const { r } = await reviewedTree(service, w);
      const reads = walkReads(service, from, modulesOf(w));
      const last = names[63]!;
      expect({
        outcome: outcome(r.response),
        rows: r.rows.length,
        refusals: r.refusals.map((x) => [x.reason, x.text]),
        reads: reads.length,
        accepted: reads.filter(([, accepted]) => accepted),
        first: reads[0],
        lastRead: reads.at(-1),
        past: reads.some(([folder]) => folder === folderOf(last, 17)),
      }).toEqual({
        outcome: SUCCEEDED,
        rows: 64,
        refusals: [["limit", TEXTS.limit]],
        reads: 1_024,
        accepted: [],
        first: ["n00", false],
        lastRead: [folderOf(last, 16), false],
        past: false,
      });
    });
  });
});

// ---- Feature 004 FR-115: the bound of 1,024 submodules (T159, contract Δ12 "Submodule bound") ----

describe("submodule bound (004 FR-115, contract Δ12 \"Submodule bound\")", () => {
  const boundCase = (name: string, fn: () => Promise<void>) => caseTest("T159", name, SHELL, fn, 10 * 60_000);
  // Literal values, so a bound of 256 turns the cases red.
  const BOUND = 1_024;
  const MIB = 1024 * 1024;
  const indexOrder = (n: number) => Array.from({ length: n }, (_, i) => countPath(i)).sort();

  boundCase("case a: 1,024 gitlinks without clones give no refusal and a token; 1,025 give limit with the 001 §12 text", async () => {
    const w = flatWorld("t159-bound", BOUND, { clone: false });
    await withTree(w, "t159-bound", async (service) => {
      const { repositoryId, r } = await reviewedTree(service, w);
      expect({ outcome: outcome(r.response), rows: r.rows.length, refusals: r.refusals.map((x) => [x.reason, x.path]), token: typeof r.token }).toEqual({ outcome: SUCCEEDED, rows: BOUND, refusals: [], token: "string" });
      addUncloned(w, BOUND, BOUND + 1);
      const over = await reviewSubmodules(service, repositoryId);
      expect({ outcome: outcome(over.response), rows: over.rows.length, limit: over.refusals.filter((x) => x.reason === "limit").map((x) => x.text) }).toEqual({ outcome: SUCCEEDED, rows: BOUND + 1, limit: [TEXTS.limit] });
    });
  });

  // 005 FR-075: the local-edit marks read keeps its own bound of 256 targets.
  boundCase("case e: 300 gitlinks give a local-edit marks read of the first 256 in index order; the 44 later rows get no mark", async () => {
    const w = flatWorld("t159-work", 300, { clone: false });
    await withTree(w, "t159-work", async (service) => {
      const { repositoryId } = await service.register(w.sup);
      const read = await readOk(service, repositoryId);
      const response = await service.request<{ entries: { path: string; state: string }[]; limited: number }>("readSubmoduleWork", { snapshotId: read.snapshotId }, { repositoryId, repositoryGeneration: read.generation });
      expect({ outcome: outcome(response), entries: response.result?.entries.map((e) => [e.path, e.state]), limited: response.result?.limited }).toEqual({
        outcome: SUCCEEDED,
        entries: indexOrder(300).slice(0, 256).map((path) => [path, "not-initialized"]),
        limited: 44,
      });
    });
  });

  boundCase("case f: 20 rows whose config listings hold more than 64 MiB in total end the review with OUTPUT_LIMIT", async () => {
    const w = flatWorld("t159-config", 20);
    const block = `[arbareto]\n${Array.from({ length: 35 }, (_, j) => `\tk${j} = ${"a".repeat(100_000)}\n`).join("")}`;
    for (let i = 0; i < 20; i++) appendFileSync(join(w.sup, ".git", "modules", flatName(i), "config"), block);
    // Premise, from the review read of each row: each listing stays below the 4 MiB bound of one row, and all pass 64 MiB together.
    const sizes = Array.from({ length: 20 }, (_, i) => ownedGit(gitPath(), FIXTURE_ROOT, w.sup, submoduleConfigListArgs({ worktree: join(w.sup, ...countPath(i).split("/")) }), { env: w.env }).length);
    console.log(`OBSERVATION T159 case f: listing bytes ${Math.min(...sizes)} to ${Math.max(...sizes)}, total ${sizes.reduce((a, b) => a + b, 0)}`);
    expect({ each: sizes.every((n) => n < TRUST_INPUT_BYTES), total: sizes.reduce((a, b) => a + b, 0) > 64 * MIB }).toEqual({ each: true, total: true });
    await withTree(w, "t159-config", async (service) => {
      const { r } = await reviewedTree(service, w);
      expect({ state: r.response.state, code: r.response.code, token: r.token }).toEqual({ state: "failed", code: "OUTPUT_LIMIT", token: undefined });
    });
  });

  boundCase("case g: readWorkspace with 1,025 gitlinks without clones gives count 1,025 and the first 1,024 paths in index order", async () => {
    const w = flatWorld("t159-notice", BOUND + 1, { clone: false });
    await withTree(w, "t159-notice", async (service) => {
      await underTestSubmodule("status");
      const { repositoryId } = await service.register(w.sup);
      expect(noticeOf(await readOk(service, repositoryId))).toEqual({ count: BOUND + 1, paths: indexOrder(BOUND + 1).slice(0, BOUND), filter: "applied" });
    });
  });
});
