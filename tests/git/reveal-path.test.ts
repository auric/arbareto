// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T034: `revealPath` (contract Δ3 and Δ6 `reveal`). The service maps an entry of its current read to a path, and the shell double checks it as the shell does.

import { describe, expect } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RevealPathResult } from "../../src/contracts/envelope";
import { NATIVE } from "../../src/contracts/native-path";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { entryOf, git, gitPath, readOk, withService } from "./hunk-harness";
import { caseTest, type Capability, type Service } from "./service-harness";
import { buildWorkbench, canary } from "./workbench-fixtures";

printOrigin("../../src/git-service/session.ts", import.meta.dir);
printOrigin("../../src/git-service/native-runner.ts", import.meta.dir);
useFixtureRoot();

const TASK = "T034";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

let builds = 0;
const tree = () => buildWorkbench(gitPath(), "staging-tree", `t034-reveal-${++builds}`).repo;
const reveal = (service: Service, repositoryId: string, entryId: string) => service.request("revealPath", { repositoryId, entryId });
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const revealed = (service: Service, from: number) => service.runner.frames.slice(from).filter((f) => f.type === "reveal").map((f) => f.path);

describe("revealPath (contract Δ3)", () => {
  caseTest(TASK, "an unstaged file and an untracked file of the current read reach the shell as their native paths below the worktree root", SHELL, () =>
    withService({ name: "t034-reveal" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const from = service.runner.frames.length;
      for (const [path, category] of [["src/a.txt", "unstaged"], ["src/new-dir/n1.txt", "untracked"]] as const) {
        expect({ path, ...outcome(await reveal(service, repositoryId, entryOf(read, path, category).entryId)) }).toEqual({ path, state: "succeeded", code: undefined });
      }
      expect(revealed(service, from)).toEqual([NATIVE.path.join(read.identity.worktreeRoot, "src", "a.txt"), NATIVE.path.join(read.identity.worktreeRoot, "src", "new-dir", "n1.txt")]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "an unknown repository or entry, and an entry of an earlier read, give UNKNOWN_TARGET before any reveal request; a path that vanished gives UNKNOWN_TARGET from the shell", SHELL, () =>
    withService({ name: "t034-reveal-unknown" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const first = await readOk(service, repositoryId);
      const from = service.runner.frames.length;
      expect(outcome(await reveal(service, crypto.randomUUID(), first.entries[0]!.entryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
      expect(outcome(await reveal(service, repositoryId, crypto.randomUUID()))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
      // A changed working tree gives a new read, so the entry IDs of the first read are no longer current.
      writeFileSync(join(repo, "top.txt"), "top changed\n");
      const second = await readOk(service, repositoryId);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(outcome(await reveal(service, repositoryId, entryOf(first, "src/a.txt", "unstaged").entryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
      expect(revealed(service, from)).toEqual([]);
      rmSync(join(repo, "docs", "d.txt"));
      expect(outcome(await reveal(service, repositoryId, entryOf(second, "docs/d.txt", "unstaged").entryId))).toEqual({ state: "failed", code: "UNKNOWN_TARGET" });
      expect(revealed(service, from).length).toBe(1);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a file that vanished after the read gives UNKNOWN_TARGET with reason absent from the walk (feature 005 contract Δ3)", SHELL, () =>
    withService({ name: "t036-reveal-absent-file" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      rmSync(join(repo, "docs", "d.txt"));
      const response = await reveal(service, repositoryId, entryOf(read, "docs/d.txt", "unstaged").entryId);
      expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "UNKNOWN_TARGET", result: { reason: "absent" } });
      expect(RevealPathResult.safeParse(response.result).success).toBe(true);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Cancel during the reveal walk ends canceled, and the walk sends no reply", SHELL, () =>
    withService({ name: "t034-reveal-cancel" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      service.runner.inject.holdWalk = () => new Promise<void>(() => {});
      try {
        const requestId = service.send("revealPath", { repositoryId, entryId: entryOf(read, "src/a.txt", "unstaged").entryId });
        const operationId = await service.operationId(requestId);
        await service.cancel(operationId);
        expect(outcome(await service.response(requestId))).toEqual({ state: "canceled", code: "CANCELED" });
      } finally {
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );
});

// T036: the folder form of `revealPath` (feature 005 contract Δ3, plan.md D5, spec FR-018, FR-019).
const FOLDER_TASK = "T036";
const revealFolder = (service: Service, repositoryId: string, entryId: string, folder: string) => service.request("revealPath", { repositoryId, entryId, folder: Buffer.from(folder).toString("base64") });

describe("revealPath with folder (feature 005 contract Δ3)", () => {
  caseTest(FOLDER_TASK, "a proper prefix of the entry path that a / follows reaches the shell as the native folder path below the worktree root", SHELL, () =>
    withService({ name: "t036-reveal-folder" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const from = service.runner.frames.length;
      const n1 = entryOf(read, "src/new-dir/n1.txt", "untracked").entryId;
      const c = entryOf(read, "src/lib/deep/c.txt", "unstaged").entryId;
      for (const [entryId, folder] of [[n1, "src/new-dir"], [n1, "src"], [c, "src/lib/deep"], [c, "src/lib"]] as const) {
        const response = await revealFolder(service, repositoryId, entryId, folder);
        expect({ folder, ...outcome(response), result: response.result }).toEqual({ folder, state: "succeeded", code: undefined, result: undefined });
      }
      const root = read.identity.worktreeRoot;
      expect(revealed(service, from)).toEqual([NATIVE.path.join(root, "src", "new-dir"), NATIVE.path.join(root, "src"), NATIVE.path.join(root, "src", "lib", "deep"), NATIVE.path.join(root, "src", "lib")]);
    }),
    TIMEOUT_MS,
  );

  caseTest(FOLDER_TASK, "a folder that is no proper prefix followed by / gives INVALID_REQUEST before any reveal request", SHELL, () =>
    withService({ name: "t036-reveal-folder-invalid" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const from = service.runner.frames.length;
      const n1 = entryOf(read, "src/new-dir/n1.txt", "untracked").entryId;
      for (const folder of ["src/new", "src/new-dir/n1.txt", "src/new-dir/", "/src", "docs", "src/new-dir/n1.txt/x", "SRC"]) {
        expect({ folder, ...outcome(await revealFolder(service, repositoryId, n1, folder)) }).toEqual({ folder, state: "rejected", code: "INVALID_REQUEST" });
      }
      expect(revealed(service, from)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(FOLDER_TASK, "a folder removed after the read gives UNKNOWN_TARGET with reason absent, and no Explorer window opens", SHELL, () =>
    withService({ name: "t036-reveal-folder-absent" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      rmSync(join(repo, "src", "new-dir"), { recursive: true });
      const response = await revealFolder(service, repositoryId, entryOf(read, "src/new-dir/n1.txt", "untracked").entryId, "src/new-dir");
      expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "UNKNOWN_TARGET", result: { reason: "absent" } });
    }),
    TIMEOUT_MS,
  );

  caseTest(FOLDER_TASK, "the folder reveal starts no Git process and needs no trust approval: a command-valued core.fsmonitor set after the read never runs", SHELL, () =>
    withService({ name: "t036-reveal-folder-trust" }, async (service) => {
      const repo = tree();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const monitor = canary(join(repo, ".."), "t036-fsmonitor");
      git(repo, ["config", "core.fsmonitor", monitor.command]);
      const calls = service.runner.calls.length;
      const response = await revealFolder(service, repositoryId, entryOf(read, "src/new-dir/n1.txt", "untracked").entryId, "src/new-dir");
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(service.runner.calls.length).toBe(calls);
      expect(existsSync(monitor.log)).toBe(false);
    }),
    TIMEOUT_MS,
  );
});
