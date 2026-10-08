// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T107: research R3 steps 4 and 13, contract §4 "Hunk eligibility and publication", §8 "Observed locks", and §9 "Other locks".
// Every refusal leaves the index byte-identical (tests/git/git-oracle.ts).

import { describe, expect } from "bun:test";
import { existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  const mtimeNs = statSync(scratch, { bigint: true }).mtimeNs;
  unlinkSync(scratch);
  return { repo, index, lockPath: `${index}.lock`, candidate, mtimeNs, before: repoState(repo) };
}

// The first stdout line of the holder, within a hard 15-second bound. An early exit or the bound fails the test.
async function heldLine(holder: Bun.Subprocess<"ignore", "pipe", "ignore">): Promise<string> {
  const reader = holder.stdout.getReader();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("holder gave no line within 15 s")), 15_000)));
  const exited = holder.exited.then((code) => Promise.reject(new Error(`holder exited with ${code}`)));
  try {
    while (!text.includes("\n")) {
      const chunk = await Promise.race([reader.read(), bound, exited]);
      if (chunk.done) throw new Error("holder closed stdout");
      text += new TextDecoder().decode(chunk.value);
    }
    return text.slice(0, text.indexOf("\n")).trimEnd();
  } finally {
    clearTimeout(timer);
    exited.catch(() => {});
    reader.releaseLock();
  }
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
      const { repo, index, lockPath, candidate, mtimeNs, before } = setup("t107-publish");
      const lock = await owned(index);
      expect(await lock.publish(candidate, mtimeNs)).toEqual({ published: true });
      expect(new Uint8Array(readFileSync(index))).toEqual(candidate);
      // Contract §4 "Published time": the published index has the candidate time or an earlier one.
      expect(statSync(index, { bigint: true }).mtimeNs).toBeLessThanOrEqual(mtimeNs);
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
      const { repo, index, lockPath, candidate, mtimeNs, before } = setup("t107-swapped");
      const lock = await owned(index);
      // A writer that ignores the lock removes it and creates its own. NTFS gives the new file another ID.
      unlinkSync(lockPath);
      writeFileSync(lockPath, "foreign");
      expect(await lock.publish(candidate, mtimeNs)).toEqual({ published: false, reason: "notOwned" });
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
      const { repo, index, lockPath, candidate, mtimeNs, before } = setup("t107-removed");
      const lock = await owned(index);
      unlinkSync(lockPath);
      expect(await lock.publish(candidate, mtimeNs)).toEqual({ published: false, reason: "notOwned" });
      expect(existsSync(lockPath)).toBe(false);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  // MS-FSCC 2.1.9: 0 and all ones are no unique file ID. Bun can show all ones as -1.
  for (const [name, id] of [["0", 0n], ["-1", -1n], ["all ones", 0xffff_ffff_ffff_ffffn]] as const) {
    caseTest(
      TASK,
      `a lock handle with file ID ${name} refuses with file-id, removes the lock by its token, and the index stays byte-identical`,
      [],
      async () => {
        const { repo, index, lockPath, before } = setup(`t107-file-id-${name.replace(" ", "-")}`);
        expect(await createIndexLock(index, id)).toEqual({ ok: false, reason: "file-id", path: lockPath, removed: true });
        expect(existsSync(lockPath)).toBe(false);
        expect(repoState(repo)).toEqual(before);
      },
      TIMEOUT_MS,
    );
  }

  // F15: another process holds the index without delete sharing. The replacement then fails at once, and the index stays.
  caseTest(
    TASK,
    "F15 sharing violation: the replacement fails, the index stays byte-identical, and the owned lock is released",
    ["windows-path-rules", "pwsh"],
    async () => {
      const { repo, index, lockPath, candidate, mtimeNs, before } = setup("t107-sharing");
      const lock = await owned(index);
      const script = `try { $f = [IO.File]::Open('${index.replaceAll("'", "''")}', 'Open', 'Read', 'Read') } catch { exit 3 }; [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 30; $f.Close()`;
      const holder = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore" });
      try {
        expect(await heldLine(holder)).toBe("held");
        // OS fact: Windows refuses another write open while the holder shares only read access.
        expect(() => openSync(index, "r+")).toThrow(expect.objectContaining({ code: "EBUSY" }));
        const started = performance.now();
        const result = await lock.publish(candidate, mtimeNs);
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
