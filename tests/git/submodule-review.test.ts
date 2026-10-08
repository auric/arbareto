// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T222: `reviewSubmodules` and the `submoduleNotice` of `readWorkspace` (contract §12 "Discovery notice", "Review reads", "Plan", "Refusals", "Trust").
// `src/git-service/submodule-review.ts` and the notice of `src/git-service/status.ts` come with T229. T231 registers the operations in the session.

import { describe, expect, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { APPROVAL_LIFETIME_MS, SUBMODULE_REVIEW_SUBMODULES } from "../../src/contracts/limits";
import { redactUrlUserInfo, type SubmoduleAction } from "../../src/contracts/submodules";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF27, buildF28, buildF29, F27_TOKEN_URL, put, type Built, type F27Variant, type F28Variant } from "./fixtures";
import { fileSha256, rawIndexDigest, refState, workingFileDigests } from "./git-oracle";
import { gitPath, readOk, TIMEOUT_MS, todoCase, valuesOf } from "./hunk-harness";
import { caseTest, withFsCalls, type Capability, type Service } from "./service-harness";
import {
  actionsOf,
  callsSince,
  commandOf,
  copySuper,
  fixtureGit,
  gitLocation,
  isReviewRead,
  moduleDirOf,
  NOTES,
  oracleOf,
  ranCanaries,
  reviewSubmodules,
  rowOf,
  saveCommand,
  submoduleCalls,
  superOf,
  TEXTS,
  underTestSubmodule,
  UPDATE_TEXT,
  updateCommand,
  updateSteps,
  updateSubmodules,
  withFixture,
  type SubmoduleRefusal,
  type SubmoduleReview,
} from "./submodule-harness";

printOrigin("../../src/contracts/submodules.ts", import.meta.dir);

const TASK = "T222";
const REVIEW = "(needs T229/T231)";
const TOKEN = "(needs T229/T230/T231)";
const SHELL: Capability[] = ["shell-double"];

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
    todoCase(TASK, `F27 ${variant}: each row has the action and the notes that Git's own update in a copy confirms, and each URL equals the configured or .gitmodules value ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F27 behind-present at its target and initialized recursively: the row is none, and the nested row has depth 1 and its parent row ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F27 unreachable-target: the row is fetch-checkout, and the runner sees rev-list -n 1 <target> --not --all in that submodule ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F27 kept-remote: the reuse row lists both remotes, redacted, and marks origin; without the matching remote it shows the differs note ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F27 kept-remote: a kept remote URL with a token shows <redacted> in the row, and no response or log holds the token ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F28 inactive: active=false without submodule.active gives the activation note ${REVIEW}`, SHELL, () => {
    const b = buildF28(gitPath(), "t222-plan-inactive", "inactive");
    return withFixture(b, "t222-plan-inactive", async (service) => {
      const { r } = await reviewed(service, b);
      expect(rowOf(r, "solo").notes).toContain(NOTES.activates);
    });
  });

  todoCase(TASK, `F28 active-pathspec: a submodule outside the submodule.active pathspec is skip ${REVIEW}`, SHELL, () => {
    const b = buildF28(gitPath(), "t222-plan-active-pathspec", "active-pathspec");
    return withFixture(b, "t222-plan-active-pathspec", async (service) => {
      const { r } = await reviewed(service, b);
      expect(actionsOf(r)).toEqual({ mid: "clone", solo: "skip" });
    });
  });

  todoCase(TASK, `F27 update-none: the uninitialized update = none row is skip with the registration note ${REVIEW}`, SHELL, () => {
    const b = buildF27(gitPath(), "t222-skip-update-none", "update-none");
    return withFixture(b, "t222-skip-update-none", async (service) => {
      const { r } = await reviewed(service, b);
      const row = rowOf(r, "solo");
      expect({ action: row.action, refusal: row.refusal }).toEqual({ action: "skip", refusal: null });
      expect(row.notes).toContain(NOTES.registers);
    });
  });

  todoCase(TASK, `F27 base with .gitmodules update = rebase: the clone row does not refuse ${REVIEW}`, SHELL, () => {
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
    ["path", (b) => ({ path: Buffer.from(b.facts.notes.invalidPath as string, "hex").toString("utf8"), reason: "path", text: TEXTS.path(Buffer.from(b.facts.notes.invalidPath as string, "hex").toString("utf8")), command: null })],
    ["remote-name", (b) => ({ path: "solo", reason: "remote-name", text: TEXTS.remoteName("solo", remoteName(b)), command: null })],
  ];
  const shape = (x: SubmoduleRefusal) => ({ path: x.path, reason: x.reason, text: x.text, command: x.remedy?.command ?? null, ...(x.remedy?.text === undefined ? {} : { remedyText: x.remedy.text }) });

  for (const [variant, expected] of CASES) {
    todoCase(TASK, `F28 ${variant}: the review gives UNSUPPORTED_SUBMODULE with its reason, its contract §12 text and remedy, and no canary runs ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F28 path: the review gives reason path, starts no Git process inside a submodule, and every repository digest stays equal ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F28 folder: the folder check reads no file data; an absent folder and an empty folder pass ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F28 prune: the review passes with a fetch-checkout row, because every ref counts; for-each-ref runs without --exclude ${REVIEW}`, SHELL, () => {
    const b = buildF28(gitPath(), "t222-refuse-prune", "prune");
    return withFixture(b, "t222-refuse-prune", async (service) => {
      const { r } = await reviewed(service, b);
      expect({ action: rowOf(r, "solo").action, refusals: r.refusals }).toEqual({ action: "fetch-checkout", refusals: [] });
      const refs = callsSince(service).filter((c) => commandOf(c.arguments)[0] === "for-each-ref");
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.flatMap((c) => c.arguments.filter((a) => a.startsWith("--exclude")))).toEqual([]);
    });
  });

  todoCase(TASK, `F28 deinit-unsaved: the kept Git folder is read with --git-dir and --work-tree, and the review gives unsaved-commits ${REVIEW}`, SHELL, () => {
    const b = buildF28(gitPath(), "t222-refuse-deinit", "deinit-unsaved");
    const dir = kept(b, "solo");
    return withFixture(b, "t222-refuse-deinit", async (service) => {
      const { r } = await reviewed(service, b);
      expect(r.refusals.map((x) => [x.path, x.reason])).toEqual([["solo", "unsaved-commits"]]);
      const reads = callsSince(service).filter((c) => commandOf(c.arguments)[0] === "for-each-ref" && c.arguments.some((a) => a.startsWith("--git-dir=") && relative(dir, a.slice(10)) === ""));
      expect(reads.map((c) => c.arguments.filter((a) => a.startsWith("--work-tree=")).map((a) => relative(dir, a.slice(12))))).toEqual([[""]]);
    });
  });

  todoCase(TASK, `a nested kept folder with an unsaved HEAD that the walk finds gives unsaved-commits with the --git-dir save command ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `F28 detached-unsaved with update = merge: unsaved-commits comes before update-mode ${REVIEW}`, SHELL, () => {
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

  // The task names a test-injected bound. No seam lowers the §5 bound, so the copy holds one gitlink more than SUBMODULE_REVIEW_SUBMODULES.
  todoCase(TASK, `F27 base with ${SUBMODULE_REVIEW_SUBMODULES + 1} gitlinks gives limit with the update command without a path ${REVIEW}`, SHELL, () => {
    const b = buildF27(gitPath(), "t222-refuse-limit", "base");
    passReviewBound(b, superOf(b));
    return withFixture(b, "t222-refuse-limit", async (service) => {
      const { r } = await reviewed(service, b);
      const limit = r.refusals.filter((x) => x.reason === "limit");
      expect(limit.map((x) => ({ text: x.text, command: x.remedy?.command ?? null, remedyText: x.remedy?.text }))).toEqual([{ text: TEXTS.limit, command: updateCommand(superOf(b)), remedyText: UPDATE_TEXT }]);
    });
  });

  todoCase(TASK, `a copy with update-mode, gitdir-config, and limit beside unsaved-commits and no-url lists unsaved-commits and no-url first ${REVIEW}`, SHELL, () => {
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

  todoCase(TASK, `a test-injected folder read error gives REPOSITORY_UNAVAILABLE with the path, and no token goes out ${REVIEW}`, SHELL, () => {
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
  const programDigests = (b: Built, label: string) => {
    const gitDir = join(b.root, (b.facts.notes.programs as Record<string, string>)[label]!);
    const hooks = (b.facts.notes.hookEvents as string[]).map((e) => fileSha256(join(gitDir, "hooks", e)));
    const keys = ["fsmonitor", "clean", "smudge", "ssh", "credential", "uploadpack"].map((k) => fileSha256(script(b, `${label}-${k}`)));
    return [...hooks, ...keys];
  };

  todoCase(TASK, `F29 base: the review lists every canary program with its origin and digest, and no canary runs during the review ${REVIEW}`, SHELL, () => {
    const b = buildF29(gitPath(), "t222-programs-base", "base");
    return withFixture(b, "t222-programs-base", async (service) => {
      const { r } = await reviewed(service, b);
      expect(ranCanaries(b)).toEqual([]);
      const digests = r.programs.map((p) => p.digest);
      for (const label of ["mid", "mid-leaf"]) for (const d of programDigests(b, label)) expect({ label, d, listed: digests.includes(d) }).toEqual({ label, d, listed: true });
      expect(r.programs.every((p) => p.origin !== "")).toBe(true);
      expect(r.programs.filter((p) => p.key === "core.fsmonitor").map((p) => p.digest).sort()).toEqual([fileSha256(script(b, "mid-fsmonitor")), fileSha256(script(b, "mid-leaf-fsmonitor"))].sort());
    });
  });

  todoCase(TASK, `F29 relative-hooks: the review lists one unchecked hooks directory for each clone, reuse, checkout, and fetch-checkout row ${REVIEW}`, SHELL, () => {
    const b = buildF29(gitPath(), "t222-programs-relative", "relative-hooks");
    return withFixture(b, "t222-programs-relative", async (service) => {
      const { r } = await reviewed(service, b);
      expect(actionsOf(r)).toEqual(b.facts.notes.rows as Record<string, SubmoduleAction>);
      const unchecked = r.programs.filter((p) => p.digest === "unchecked");
      const perRow = Object.keys(b.facts.notes.rows as Record<string, string>).map((path) => ({ path, keys: unchecked.filter((p) => "rowId" in p && p.rowId === rowOf(r, path).rowId).map((p) => p.key) }));
      expect(perRow).toEqual(Object.keys(b.facts.notes.rows as Record<string, string>).map((path) => ({ path, keys: ["core.hooksPath"] })));
    });
  });

  // `--git-dir=<folder>` and `--work-tree=<folder>` of each `rev-parse --absolute-git-dir` call, as folder paths.
  const walkReads = (service: Service) =>
    callsSince(service)
      .filter((c) => commandOf(c.arguments).join(" ") === "rev-parse --absolute-git-dir")
      .map((c) => ({ gitDir: c.arguments.find((a) => a.startsWith("--git-dir="))?.slice(10), workTree: c.arguments.find((a) => a.startsWith("--work-tree="))?.slice(12) }));

  todoCase(TASK, `F29 kept-folder: the review lists the canaries of the top-level and the nested kept Git folder, reads each with --git-dir=<folder> --work-tree=<folder>, skips the non-Git folder, and finds the name with / ${REVIEW}`, SHELL, () => {
    const b = buildF29(gitPath(), "t222-programs-kept", "kept-folder");
    const keptDirs = Object.values(b.facts.notes.kept as Record<string, string>).map((d) => join(b.root, d));
    const nonGit = join(b.root, b.facts.notes.nonGitFolder as string);
    return withFixture(b, "t222-programs-kept", async (service) => {
      const { r } = await reviewed(service, b);
      expect(ranCanaries(b)).toEqual([]);
      const digests = r.programs.map((p) => p.digest);
      for (const label of ["mid", "mid-leaf"]) for (const d of programDigests(b, label)) expect({ label, listed: digests.includes(d) }).toEqual({ label, listed: true });
      const reads = walkReads(service);
      for (const dir of keptDirs) expect({ dir, read: reads.some((x) => x.gitDir !== undefined && relative(dir, x.gitDir) === "" && x.workTree !== undefined && relative(dir, x.workTree) === "") }).toEqual({ dir, read: true });
      expect(r.programs.filter((p) => "gitDirectory" in p && !relative(nonGit, p.gitDirectory).startsWith(".."))).toEqual([]);
    });
  });

  todoCase(TASK, `F29 kept-nested: the review lists the canaries of the nested kept folder inside an initialized submodule ${REVIEW}`, SHELL, () => {
    const b = buildF29(gitPath(), "t222-programs-kept-nested", "kept-nested");
    return withFixture(b, "t222-programs-kept-nested", async (service) => {
      const { r } = await reviewed(service, b);
      expect(ranCanaries(b)).toEqual([]);
      const digests = r.programs.map((p) => p.digest);
      for (const d of programDigests(b, "mid-leaf")) expect(digests).toContain(d);
    });
  });

  // The task names a test-injected walk. No seam lowers the §5 bound, so the copy holds one folder more than SUBMODULE_REVIEW_SUBMODULES under `modules`.
  todoCase(TASK, `a modules walk above ${SUBMODULE_REVIEW_SUBMODULES} folders gives limit ${REVIEW}`, SHELL, () => {
    const b = buildF27(gitPath(), "t222-programs-walk", "base");
    const modules = join(superOf(b), ".git", "modules", "walk");
    for (let i = 0; i <= SUBMODULE_REVIEW_SUBMODULES; i++) mkdirSync(join(modules, `f${i}`), { recursive: true });
    return withFixture(b, "t222-programs-walk", async (service) => {
      const { r } = await reviewed(service, b);
      expect(r.refusals.map((x) => ({ reason: x.reason, text: x.text }))).toEqual([{ reason: "limit", text: TEXTS.limit }]);
    });
  });

  todoCase(TASK, `F29 base: inside submodules, the runner sees only the review reads, each with --no-lazy-fetch --no-optional-locks first ${REVIEW}`, SHELL, () => {
    const b = buildF29(gitPath(), "t222-programs-reads", "base");
    return withFixture(b, "t222-programs-reads", async (service) => {
      await reviewed(service, b);
      const inside = submoduleCalls(service, superOf(b));
      expect(inside.length).toBeGreaterThan(0);
      expect(inside.filter((c) => !isReviewRead(c.arguments)).map((c) => c.arguments)).toEqual([]);
    });
  });

  todoCase(TASK, `the review waits for read trust like other reads: after Revoke trust it gives TRUST_REQUIRED and starts no Git process inside a submodule ${REVIEW}`, SHELL, () => {
    const b = buildF27(gitPath(), "t222-programs-trust", "behind-present");
    const monitor = put(b.root, "programs/monitor.sh", "#!/bin/sh\nexit 1\n").replaceAll("\\", "/");
    fixtureGit(b, superOf(b), ["config", "core.fsmonitor", `'${monitor}'`]);
    return withFixture(b, "t222-programs-trust", async (service) => {
      await review();
      const { repositoryId } = await service.register(superOf(b));
      const trust = await service.readTrust(repositoryId);
      expect(trust.result!.approvalRequired.reads).toBe(true);
      await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation);
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

  for (const [what, { variant, change }] of Object.entries(CHANGES)) {
    todoCase(TASK, `a change of ${what} after the review makes updateSubmodules give STALE_REVIEW, and no update step starts ${TOKEN}`, SHELL, () => {
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

  todoCase(TASK, `a token older than APPROVAL_LIFETIME_MS on an injected clock gives APPROVAL_EXPIRED, and no update step starts ${TOKEN}`, SHELL, () => {
    const b = buildF27(gitPath(), "t222-token-expired", "base");
    return withFixture(b, "t222-token-expired", async (service) => {
      const { repositoryId, r } = await reviewed(service, b);
      expect(typeof r.token).toBe("string");
      await underTestSubmodule("submodule-update");
      const from = service.runner.calls.length;
      // Bun `setSystemTime` moves `Date.now()` only. Timers and `performance.now()` keep running.
      setSystemTime(new Date(Date.now() + APPROVAL_LIFETIME_MS + 1));
      try {
        const response = await updateSubmodules(service, repositoryId, r);
        expect({ code: response.code, steps: updateSteps(service, from).length }).toEqual({ code: "APPROVAL_EXPIRED", steps: 0 });
      } finally {
        setSystemTime();
      }
    });
  });
});
