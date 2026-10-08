// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T107: research R3 steps 4 and 13, contract §4 "Hunk eligibility and publication", §8 "Observed locks", and §9 "Other locks".
// Every refusal leaves the index byte-identical (tests/git/git-oracle.ts).

import { describe, expect } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createIndexLock, LOCKED_REMEDY } from "../../src/git-service/index-lock";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF02, put } from "./fixtures";
import { git, gitPath, gitPathOf, repoOf, repoState, TIMEOUT_MS } from "./hunk-harness";
import { caseTest } from "./service-harness";

printOrigin("../../src/git-service/index-lock.ts", import.meta.dir);

const TASK = "T107";
useFixtureRoot();

// A repository and the bytes of a second index: the index after `git add` of one changed file, built through a private index.
function setup(name: string) {
  const repo = repoOf(buildF02(gitPath(), name));
  const index = gitPathOf(repo, "index");
  put(repo, "a.txt", "changed\n");
  const scratch = `${index}.scratch`;
  writeFileSync(scratch, readFileSync(index));
  git(repo, ["add", "a.txt"], { env: { GIT_INDEX_FILE: scratch } });
  const candidate = new Uint8Array(readFileSync(scratch));
  unlinkSync(scratch);
  return { repo, index, lockPath: `${index}.lock`, candidate, before: repoState(repo) };
}

async function owned(index: string) {
  const created = await createIndexLock(index);
  if (!created.ok) throw new Error(`lock refused: ${JSON.stringify(created)}`);
  return created.lock;
}

describe("index lock (T107)", () => {
  caseTest(
    TASK,
    "the service creates the Git-resolved index.lock exclusively and removes only its own lock",
    [],
    async () => {
      const { repo, index, lockPath, before } = setup("t107-own");
      const lock = await owned(index);
      expect(lock.path).toBe(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      // Git sees the lock as held: its own index write fails.
      expect(() => git(repo, ["update-index", "--refresh"])).toThrow();
      expect(await lock.release()).toBe("removed");
      expect(existsSync(lockPath)).toBe(false);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an existing lock gives LOCKED with its path, and the service never removes it",
    [],
    async () => {
      const { repo, index, lockPath, before } = setup("t107-locked");
      writeFileSync(lockPath, "foreign");
      expect(await createIndexLock(index)).toEqual({ ok: false, code: "LOCKED", path: lockPath, remedy: { text: LOCKED_REMEDY } });
      expect(readFileSync(lockPath, "utf8")).toBe("foreign");
      unlinkSync(lockPath);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "publication writes the candidate bytes into the owned lock and renames it over the index once",
    [],
    async () => {
      const { repo, index, lockPath, candidate, before } = setup("t107-publish");
      const lock = await owned(index);
      expect(await lock.publish(candidate)).toEqual({ published: true });
      expect(new Uint8Array(readFileSync(index))).toEqual(candidate);
      expect(existsSync(lockPath)).toBe(false);
      const after = repoState(repo);
      expect(after.files).toEqual(before.files);
      expect(after.entries).not.toEqual(before.entries);
      // A finished lock owns nothing.
      expect(await lock.release()).toBe("notOwned");
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a lock that another writer replaced is not owned: no publication, and the foreign lock stays",
    [],
    async () => {
      const { repo, index, lockPath, candidate, before } = setup("t107-swapped");
      const lock = await owned(index);
      // A writer that ignores the lock removes it and creates its own. NTFS gives the new file another ID.
      unlinkSync(lockPath);
      writeFileSync(lockPath, "foreign");
      expect(await lock.publish(candidate)).toEqual({ published: false, reason: "notOwned" });
      expect(readFileSync(lockPath, "utf8")).toBe("foreign");
      expect(await lock.release()).toBe("notOwned");
      expect(readFileSync(lockPath, "utf8")).toBe("foreign");
      unlinkSync(lockPath);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a removed lock is not owned, and release removes nothing",
    [],
    async () => {
      const { repo, index, lockPath, candidate, before } = setup("t107-removed");
      const lock = await owned(index);
      unlinkSync(lockPath);
      expect(await lock.publish(candidate)).toEqual({ published: false, reason: "notOwned" });
      expect(existsSync(lockPath)).toBe(false);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  // F15: another process holds the index without delete sharing. The replacement then fails at once, and the index stays.
  caseTest(
    TASK,
    "F15 sharing violation: the replacement fails, the index stays byte-identical, and the owned lock is released",
    ["windows-path-rules", "pwsh"],
    async () => {
      const { repo, index, lockPath, candidate, before } = setup("t107-sharing");
      const lock = await owned(index);
      const script = `$f = [IO.File]::Open('${index.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); 'held'; Start-Sleep -Seconds 30; $f.Close()`;
      const holder = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore" });
      try {
        const first = await holder.stdout.getReader().read();
        expect(new TextDecoder().decode(first.value)).toStartWith("held");
        const started = performance.now();
        const result = await lock.publish(candidate);
        console.log(`F15 replacement under a sharing violation: ${JSON.stringify(result)} after ${Math.round(performance.now() - started)} ms`);
        expect(result).toEqual({ published: false, reason: "replace-failed", errno: "EPERM" });
      } finally {
        holder.kill();
        await holder.exited;
      }
      expect(existsSync(lockPath)).toBe(true);
      expect(await lock.release()).toBe("removed");
      expect(existsSync(lockPath)).toBe(false);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );
});
