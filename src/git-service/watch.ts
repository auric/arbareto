// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan.md "Freshness and reconciliation" and contract §8 "Change check". A hint only marks the workspace dirty. The next read decides.

import { constants, stat, statSync, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { lstat as lstatPath, open, stat as statPath } from "node:fs/promises";
import { NATIVE } from "../contracts/native-path";
import { noFileId } from "./index-lock";
import { isMissing } from "./read-steps";

// Plan.md "Freshness and reconciliation": the hint debounce. `limits.ts` holds only contract §5 bounds, which name `limited` reasons.
const WATCH_DEBOUNCE_MS = 100;
// T088 decision E5: the longest wait from the first event that no hint delivered yet.
const WATCH_MAX_WAIT_MS = 1000;
// Contract §8 "Change check": a larger `reftable/tables.list` counts as changed.
const TABLES_LIST_BYTES = 64 * 1024;
// Contract §8 "Watcher hints": the most hint paths after one complete read. More paths give a full read.
export const HINT_PATHS = 1000;
// Contract §8 "Watcher hints": the files that Git reads beside the ignore rules. gitignore(5), gitattributes(5), gitmodules(5), gitrepository-layout(5).
const GIT_FILES: ReadonlySet<string> = new Set([".gitignore", ".gitattributes", ".gitmodules"]);
// Node decodes a name that is no valid UTF-8 with U+FFFD, so a name with it cannot name its file.
const REPLACEMENT = String.fromCharCode(0xfffd);

// Contract §8 "Watcher hints": the worktree-relative path of an event of the worktree watch, with `/` separators.
// Null: no name, a name that holds a lone surrogate or U+FFFD, a Git file name, a path inside a Git folder, or a path outside the root.
export function worktreePath(root: string, folders: readonly string[], name: unknown): string | null {
  if (typeof name !== "string" || name === "" || !name.isWellFormed() || name.includes(REPLACEMENT)) return null;
  const parts = name.split(NATIVE.separator);
  if (GIT_FILES.has(NATIVE.fold(parts.at(-1)!)) || (parts.length === 1 && NATIVE.fold(name) === ".git")) return null;
  const path = NATIVE.path.join(root, name);
  const inside = (folder: string) => {
    const relative = NATIVE.path.relative(folder, path);
    return relative === "" || (relative.split(NATIVE.separator)[0] !== ".." && !NATIVE.path.isAbsolute(relative));
  };
  return NATIVE.path.isAbsolute(name) || !inside(root) || folders.some(inside) ? null : parts.join("/");
}

// `onHint(false, paths)` comes once per burst of changes, after the debounce. `paths`: the worktree paths of the burst. Null: one event of the burst gives no path.
// `onHint(true, null)`: a directory watch did not start or lost its directory, so later changes can give no hint.
// `directories` starts with the worktree root. Events of the other directories give no path. The result stops every watch.
export function watchWorkspace(directories: readonly string[], onHint: (lost: boolean, paths: ReadonlySet<string> | null) => void): () => void {
  const [root, ...folders] = [...new Set(directories)] as [string, ...string[]];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let paths: Set<string> | null = new Set();
  const deliver = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = undefined;
    const burst = paths;
    paths = new Set();
    if (!closed) onHint(false, burst);
  };
  const changed = (directory: string, name: unknown) => {
    const path = directory === root ? worktreePath(root, folders, name) : null;
    paths = path === null || paths === null || paths.add(path).size > HINT_PATHS ? null : paths;
    clearTimeout(timer);
    timer = setTimeout(deliver, WATCH_DEBOUNCE_MS);
    deadline ??= setTimeout(deliver, WATCH_MAX_WAIT_MS);
  };
  const lost = () => closed || onHint(true, null);
  const stops = [root, ...folders].map((directory) => watchDirectory(directory, (name) => changed(directory, name), lost));
  return () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    for (const stop of stops) stop();
  };
}

function watchDirectory(directory: string, changed: (name: unknown) => void, lost: () => void): () => void {
  let watcher: FSWatcher | undefined;
  let identity: BigIntStats;
  let check: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let recheck = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(check);
    watcher?.close();
  };
  const lose = () => {
    if (stopped) return;
    stop();
    lost();
  };
  // Bun 1.4.4 (T390 check 2) on Windows repeats events without an error after the watched directory is removed. The directory identity decides, at most once per debounce time.
  const verify = () => {
    check = setTimeout(() => {
      check = undefined;
      checking = true;
      stat(directory, { bigint: true }, (error, now) => {
        checking = false;
        if (stopped) return;
        if (error !== null || noFileId(now.ino, identity.ino) || now.dev !== identity.dev || now.ino !== identity.ino) return lose();
        // T088 decision E9: the stat can miss a change that came while it ran.
        if (recheck) {
          recheck = false;
          verify();
        }
      });
    }, WATCH_DEBOUNCE_MS);
  };
  const arm = () => {
    const armed = watch(directory, { recursive: true });
    armed.on("error", lose);
    armed.on("change", (_event, name) => {
      if (stopped) return;
      // Bun 1.4.4 gives a null name for lost events (an overflow). On Linux, an event about the recursive root itself gives an undefined name, and no error follows. After a removal, that watch stays silent. A directory created again at the path can keep the same dev and ino. T088 decision E8.
      if (name == null) {
        watcher?.close();
        watcher = undefined;
        try {
          watcher = arm();
        } catch {
          lose();
          return;
        }
      }
      changed(name);
      if (checking) recheck = true;
      else if (check === undefined) verify();
    });
    return armed;
  };
  try {
    identity = statSync(directory, { bigint: true });
    // Contract §6: with a sentinel ID, no identity check can prove the directory.
    if (!noFileId(identity.ino)) watcher = arm();
  } catch {
    watcher = undefined;
  }
  if (watcher === undefined) {
    lost();
    return () => {};
  }
  return stop;
}

// Contract §8 "Change check": one file of the stat tuple. `content` also binds the file bytes (`reftable/tables.list`).
export interface TupleFile {
  path: string;
  content: boolean;
}

// Size, last-write time, and presence, and the bytes of a `content` file. Undefined: the fact is unknown.
async function factOf(file: TupleFile): Promise<string | undefined> {
  if (!file.content) {
    try {
      const s = await statPath(file.path, { bigint: true });
      return `${s.size}:${s.mtimeNs}`;
    } catch (error) {
      return isMissing(error) ? "absent" : undefined;
    }
  }
  let handle;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open.
    handle = await open(file.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return isMissing(error) ? "absent" : undefined;
  }
  try {
    const s = await handle.stat({ bigint: true });
    if (!s.isFile() || s.size > TABLES_LIST_BYTES) return undefined;
    const bytes = new Uint8Array(TABLES_LIST_BYTES + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size);
      if (bytesRead === 0 || (size += bytesRead) === bytes.length) break;
    }
    if (size > TABLES_LIST_BYTES) return undefined;
    return `${s.size}:${s.mtimeNs}:${Buffer.from(bytes.subarray(0, size)).toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// Contract §8 "Change check": the working file of a `workingVersions` binding. `lstat` matches the binding, which never follows the last link.
// Null: the fact is unknown.
export async function statWorkingFile(path: Buffer): Promise<string | null> {
  try {
    const s = await lstatPath(path, { bigint: true });
    return `${s.size}:${s.mtimeNs}`;
  } catch (error) {
    return isMissing(error) ? "absent" : null;
  }
}

// The facts of `files` by path. Null: a fact is unknown, or a `content` file is above the bound, so no compare can prove "no change".
export async function statFiles(files: readonly TupleFile[]): Promise<Map<string, string> | null> {
  const facts = await Promise.all(files.map(factOf));
  if (facts.includes(undefined)) return null;
  return new Map(files.map((file, i) => [file.path, facts[i]!]));
}
