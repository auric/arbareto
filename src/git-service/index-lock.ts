// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T107: research R3 steps 4 and 13, contract §4 "Hunk eligibility and publication", "Windows lock ownership", "Published time", and §9 "Other locks". The Windows path.
// A WSL repository locks and publishes inside the distro (contract §4 "WSL index publication"), never through this module.

import { randomBytes } from "node:crypto";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { readHandleBounded } from "./read-steps";

// Contract §9.
export const LOCKED_REMEDY = "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows.";

// MS-FSCC 2.1.9: a file ID of 0 or all ones is not unique. Bun can show all ones as -1.
const NO_FILE_ID = [0n, -1n, 0xffff_ffff_ffff_ffffn];
const NS_PER_MS = 1_000_000n;

export type PublishResult =
  | { published: true }
  | { published: false; reason: "notOwned" }
  // Contract §4 "Published time": the read-back time is later than the candidate time. The lock stays owned.
  | { published: false; reason: "time" }
  // `errno` is null for a short write.
  | { published: false; reason: "write-failed"; errno: string | null }
  | { published: false; reason: "replace-failed"; errno: string };

export interface IndexLock {
  path: string;
  // Writes `bytes` into the owned lock, sets its time to `mtimeNs` or earlier, and renames it over the index once. Every result but `published` leaves the index unchanged.
  publish(bytes: Uint8Array, mtimeNs: bigint): Promise<PublishResult>;
  // Removes the lock only while the path still names the owned file. `remove-failed`: the owned lock stays.
  release(): Promise<"removed" | "notOwned" | "remove-failed">;
}

export type LockResult =
  | { ok: true; lock: IndexLock }
  | { ok: false; code: "LOCKED"; path: string; remedy: { text: string } }
  // Contract §4 "Windows lock ownership": the lock handle has no unique file ID. `removed` is false when the lock can remain.
  | { ok: false; reason: "file-id"; path: string; removed: boolean }
  // Another create failure. Contract §9 names no code for it.
  | { ok: false; reason: "create-failed"; errno: string; path: string };

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";

// Contract §4 "Windows lock ownership": Git never writes a 64-hex-digit token into `index.lock`, so a lock with exactly the token is ours.
async function removeByToken(handle: FileHandle, path: string): Promise<boolean> {
  const token = Buffer.from(randomBytes(32).toString("hex"));
  try {
    const { bytesWritten } = await handle.write(token, 0, token.length, 0);
    if (bytesWritten !== token.length) return false;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
  let held: FileHandle;
  try {
    held = await open(path, "r");
  } catch {
    return false;
  }
  try {
    const bytes = await readHandleBounded(held, token.length);
    if (bytes === "over" || Buffer.compare(bytes, token) !== 0) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  } finally {
    await held.close();
  }
}

// `testFileId` is a test seam only. Production never sets it. It replaces the file ID of the held handle.
export async function createIndexLock(indexPath: string, testFileId?: bigint): Promise<LockResult> {
  // Git `lockfile.h` LOCK_SUFFIX. The lock lies in the folder of the index, so on the same volume.
  const path = `${indexPath}.lock`;
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
  if (NO_FILE_ID.includes(testFileId ?? own.ino)) return { ok: false, reason: "file-id", path, removed: await removeByToken(handle, path) };
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
      async publish(bytes, mtimeNs) {
        if (!live) return { published: false, reason: "notOwned" };
        try {
          await handle.truncate(0);
          const { bytesWritten } = await handle.write(bytes, 0, bytes.length, 0);
          if (bytesWritten !== bytes.length) return { published: false, reason: "write-failed", errno: null };
          await handle.sync();
          // Node.js sets whole milliseconds, so this is the whole millisecond at or before `mtimeNs`.
          const time = new Date(Number(mtimeNs / NS_PER_MS));
          await handle.utimes(time, time);
          if ((await handle.stat({ bigint: true })).mtimeNs > mtimeNs) return { published: false, reason: "time" };
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
        // The handle stays open until the unlink ends. A window stays between this check and the unlink, which acts on the path, as the rename in `publish` does.
        if (!(await owned())) {
          await close();
          return "notOwned";
        }
        try {
          await unlink(path);
        } catch {
          return "remove-failed";
        } finally {
          await close();
        }
        return "removed";
      },
    },
  };
}
