// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T230: the `updateSubmodules` lock set (contract §8 "Observed locks") and the recovery row states (contract §8 "Recovery statement").
// The lock and recovery cases run no Git process: a null HEAD reads no branch ref, and a row without a `.git` entry or a kept directory gets no Git read.
// The `registered` case is the control for that flag as the only effect.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUBMODULE_REVIEW_SUBMODULES } from "../../src/contracts/limits";
import type { ObserveContext } from "../../src/git-service/hunk-publish";
import type { RetainedUpdate } from "../../src/git-service/reconcile";
import { fixturePath, useFixtureRoot } from "./fixture-root";
import { underTest } from "./hunk-harness";

type Reconcile = typeof import("../../src/git-service/reconcile");
type Recovery = typeof import("../../src/git-service/recovery");

const IDENTITY = { volumeSerial: "0".repeat(16), fileId: "1".repeat(32) };
const TARGET = "2".repeat(40);

useFixtureRoot();

describe("submoduleLocks (contract §8 \"Observed locks\")", () => {
  // A files-format workspace in a new folder. Its Git directory is also its common directory.
  function workspaceAt(name: string) {
    const gitDir = fixturePath(name, ".git");
    mkdirSync(gitDir, { recursive: true });
    const workspace = { indexPath: `${gitDir}/index`, gitDirectory: gitDir, commonDirectory: gitDir, refFormat: "files" };
    return { gitDir, ctx: { workspace, signal: new AbortController().signal } as unknown as ObserveContext };
  }

  test("the set adds the superproject config.lock and index.lock and HEAD.lock of each plan Git directory, and names only existing files", async () => {
    const { submoduleLocks } = (await underTest("reconcile")) as Reconcile;
    const { gitDir, ctx } = workspaceAt("locks-set");
    const modules = ["a", "b"].map((m) => `${gitDir}/modules/${m}`);
    for (const dir of modules) mkdirSync(dir, { recursive: true });
    for (const file of ["index.lock", "config.lock", "modules/a/index.lock", "modules/a/HEAD.lock", "modules/b/HEAD.lock"]) writeFileSync(join(gitDir, file), "");
    expect(await submoduleLocks(ctx, null, [...modules, modules[0]!])).toEqual([`${gitDir}/index.lock`, `${gitDir}/config.lock`, `${modules[0]}/index.lock`, `${modules[0]}/HEAD.lock`, `${modules[1]}/HEAD.lock`]);
  });

  test("the list holds at most 5 + 2 × 256 files", async () => {
    const { submoduleLocks } = (await underTest("reconcile")) as Reconcile;
    const { gitDir, ctx } = workspaceAt("locks-cap");
    for (const file of ["index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"]) writeFileSync(join(gitDir, file), "");
    const modules = Array.from({ length: SUBMODULE_REVIEW_SUBMODULES + 4 }, (_, i) => `${gitDir}/modules/m${i}`);
    for (const dir of modules) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/index.lock`, "");
      writeFileSync(`${dir}/HEAD.lock`, "");
    }
    const locks = await submoduleLocks(ctx, null, modules);
    if (!Array.isArray(locks)) throw new Error(`no locks: ${JSON.stringify(locks)}`);
    expect({ length: locks.length, first: locks[0], last: locks.at(-1) }).toEqual({ length: 5 + 2 * SUBMODULE_REVIEW_SUBMODULES, first: `${gitDir}/index.lock`, last: `${modules[SUBMODULE_REVIEW_SUBMODULES]}/index.lock` });
  });
});

describe("classifyUpdate: the registered flag alone (contract §12 \"Reconciliation and outcome\")", () => {
  test("a failed step whose only effect is a registration gives failed-with-effects", async () => {
    const { classifyUpdate } = (await underTest("reconcile")) as Reconcile;
    const old = "1".repeat(40);
    const keys = { "submodule.solo.active": ["true"] };
    const { event, rows } = classifyUpdate({
      rows: [
        {
          rowId: "00000000-0000-4000-8000-000000000001",
          path: "solo",
          found: false,
          planned: "moved",
          oldCommit: old,
          target: TARGET,
          baseline: {},
          phase: { fetched: false, connected: false, failedStep: { firstFetch: false, outputTail: "fatal: failed\n", remedy: { command: null, text: "retry" } } },
          observed: { value: { head: old, gitEntry: true, refs: true, keys } },
        },
      ],
      stop: null,
    });
    expect({ event, registered: rows[0]!.registered }).toEqual({ event: { type: "failed-with-effects" }, registered: true });
  });
});

describe("recovery of an unknown update (contract §8 \"Recovery statement\")", () => {
  test("the refresh states each retained row from new reads, sends resolved, and drops the retained update", async () => {
    const { createRecovery } = (await underTest("recovery")) as Recovery;
    const workspace = { repositoryId: "repo", commonIdentity: IDENTITY, worktreeIdentity: [IDENTITY], worktreeRoot: fixturePath("recovery"), objectFormat: "sha1" };
    const resolved: string[] = [];
    // The superproject configuration still holds the keys that the failed clone wrote (research R14 S37).
    const entry = (key: string, value: string) => ({ scope: "local", origin: "file:.git/config", key, value, exact: true, originBytes: new Uint8Array(), keyValueBytes: new TextEncoder().encode(`${key}\n${value}`) });
    const listing = { entries: [entry("submodule.solo.active", "true"), entry("submodule.solo.url", "C:/fixture/solo.git")], fingerprint: "f" };
    const runner = { resolved: (id: string) => resolved.push(id), fileFacts: async (r: { files: unknown[] }) => r.files.map(() => ({ kind: "absent" })) };
    const trust = { listTrust: async () => ({ ok: true, listing }), gate: () => null, view: () => ({ state: "trusted" }) };
    const updates = new Map<string, RetainedUpdate>([
      [
        "op",
        {
          rows: [
            {
              rowId: "00000000-0000-4000-8000-000000000001",
              path: "solo",
              found: false,
              planned: "cloned",
              oldCommit: null,
              target: TARGET,
              baseline: {},
              phase: { fetched: false, connected: true, failedStep: { firstFetch: false, outputTail: "fatal: clone failed\n", remedy: { command: null, text: "clone" } } },
              read: { components: ["solo"], name: "solo", kept: null, parent: null },
            },
          ],
        },
      ],
    ]);
    const recovery = createRecovery({
      runner,
      registry: { get: () => undefined },
      trust,
      reader: { recoveryState: () => "ready" },
      publications: new Map(),
      commits: new Map(),
      updates,
    } as unknown as Parameters<Recovery["createRecovery"]>[0]);
    recovery.settled({ operationId: "op", workspace } as never, "marker", [IDENTITY] as never);
    const outcome = { result: "succeeded", value: { head: { state: "branch", target: "refs/heads/main", oid: TARGET } } };
    const refreshed = await recovery.refresh({ operationId: "read", signal: new AbortController().signal, workspace, installation: {} } as never, outcome as never);
    expect({ recovery: (refreshed as { value?: { recovery?: unknown } }).value?.recovery, resolved, kept: updates.has("op") }).toEqual({
      recovery: {
        outcome: "unknown",
        submoduleResults: [
          { rowId: "00000000-0000-4000-8000-000000000001", path: "solo", state: "failed", oldCommit: null, newCommit: null, fetched: false, connected: true, found: false, registered: true, outputTail: "fatal: clone failed\n", remedy: { command: null, text: "clone" } },
        ],
      },
      resolved: ["marker"],
      kept: false,
    });
  });
});
