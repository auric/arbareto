// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T107: research R3 steps 4 and 13, contract §4 "Hunk eligibility and publication", and §9 "Other locks". The Windows path.
// A WSL repository locks and publishes inside the distro (contract §4 "WSL index publication"), never through this module.

import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";

// Contract §9.
export const LOCKED_REMEDY = "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows.";

// Git `lockfile.h` LOCK_SUFFIX: the lock of a file is that path with ".lock". It lies in the same folder, so on the same volume.
const lockPathOf = (indexPath: string) => `${indexPath}.lock`;

export type PublishResult = { published: true } | { published: false; reason: "notOwned" } | { published: false; reason: "write-failed" | "replace-failed"; errno: string };

export interface IndexLock {
  path: string;
  // Writes `bytes` into the owned lock and renames it over the index once. Every result but `published` leaves the index unchanged.
  publish(bytes: Uint8Array): Promise<PublishResult>;
  // Removes the lock only while the path still names the owned file. `remove-failed`: the owned lock stays.
  release(): Promise<"removed" | "notOwned" | "remove-failed">;
}

export type LockResult =
  | { ok: true; lock: IndexLock }
  | { ok: false; code: "LOCKED"; path: string; remedy: { text: string } }
  // Another create failure. Contract §9 names no code for it.
  | { ok: false; reason: "create-failed"; errno: string; path: string };

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";

export async function createIndexLock(indexPath: string): Promise<LockResult> {
  const path = lockPathOf(indexPath);
  let handle: FileHandle;
  try {
    // "wx" is O_CREAT|O_EXCL. On Windows it is CREATE_NEW, which fails for any existing name.
    handle = await open(path, "wx");
  } catch (error) {
    const errno = errnoOf(error);
    return errno === "EEXIST" ? { ok: false, code: "LOCKED", path, remedy: { text: LOCKED_REMEDY } } : { ok: false, reason: "create-failed", errno, path };
  }
  // The identity of the open handle. NTFS file IDs hold a sequence number, so a recreated lock gets another ID.
  // The handle shares delete access, so another writer can still remove or replace the name. Each step compares the path with this identity.
  const own = await handle.stat({ bigint: true });
  let live = true;
  const close = async () => {
    if (!live) return;
    live = false;
    await handle.close();
  };
  const owned = async (): Promise<boolean> => {
    try {
      const st = await lstat(path, { bigint: true });
      return st.isFile() && st.dev === own.dev && st.ino === own.ino;
    } catch {
      return false;
    }
  };

  return {
    ok: true,
    lock: {
      path,
      async publish(bytes) {
        if (!live) return { published: false, reason: "notOwned" };
        try {
          await handle.truncate(0);
          await handle.write(bytes, 0, bytes.length, 0);
          await handle.sync();
        } catch (error) {
          return { published: false, reason: "write-failed", errno: errnoOf(error) };
        }
        // A window stays between this check and the rename. Git's `commit_lock_file` renames by path as well.
        if (!(await owned())) {
          await close();
          return { published: false, reason: "notOwned" };
        }
        try {
          await rename(path, indexPath);
        } catch (error) {
          // The handle stays open, so `release` checks the ownership again before it removes the lock.
          return { published: false, reason: "replace-failed", errno: errnoOf(error) };
        }
        await close();
        return { published: true };
      },
      async release() {
        if (!live) return "notOwned";
        const mine = await owned();
        await close();
        if (!mine) return "notOwned";
        try {
          await unlink(path);
        } catch {
          return "remove-failed";
        }
        return "removed";
      },
    },
  };
}
