// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan.md "Freshness and reconciliation" and contract §8 "Change check". A hint only marks the workspace dirty. The next read decides.

import { constants, stat, statSync, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { open, stat as statPath } from "node:fs/promises";
import { isMissing } from "./read-steps";

// Plan.md "Freshness and reconciliation": the hint debounce. `limits.ts` holds only contract §5 bounds, which name `limited` reasons.
const WATCH_DEBOUNCE_MS = 100;
// T088 decision E5: the longest wait from the first event that no hint delivered yet.
const WATCH_MAX_WAIT_MS = 1000;
// Contract §8 "Change check": a larger `reftable/tables.list` counts as changed.
const TABLES_LIST_BYTES = 64 * 1024;

// `onHint(false)` comes once per burst of changes, after the debounce. `onHint(true)`: a directory watch did not start or lost its directory, so later changes can give no hint.
// The result stops every watch.
export function watchWorkspace(directories: readonly string[], onHint: (lost: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const deliver = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = undefined;
    if (!closed) onHint(false);
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(deliver, WATCH_DEBOUNCE_MS);
    deadline ??= setTimeout(deliver, WATCH_MAX_WAIT_MS);
  };
  const lost = () => closed || onHint(true);
  const stops = [...new Set(directories)].map((directory) => watchDirectory(directory, changed, lost));
  return () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    for (const stop of stops) stop();
  };
}

function watchDirectory(directory: string, changed: () => void, lost: () => void): () => void {
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
  // Bun 1.4.2 on Windows repeats events without an error after the watched directory is removed. The directory identity decides, at most once per debounce time.
  const verify = () => {
    check = setTimeout(() => {
      check = undefined;
      checking = true;
      stat(directory, { bigint: true }, (error, now) => {
        checking = false;
        if (stopped) return;
        if (error !== null || now.dev !== identity.dev || now.ino !== identity.ino) return lose();
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
      // Bun 1.4.2 reports lost events (an overflow) as a null file name. On Linux it also reports a removed or replaced root this way, and then that watch stays silent. T088 decision E8.
      if (name === null) {
        watcher?.close();
        watcher = undefined;
        try {
          watcher = arm();
        } catch {
          lose();
          return;
        }
      }
      changed();
      if (checking) recheck = true;
      else if (check === undefined) verify();
    });
    return armed;
  };
  try {
    identity = statSync(directory, { bigint: true });
    watcher = arm();
  } catch {
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

// The facts of `files` by path. Null: a fact is unknown, or a `content` file is above the bound, so no compare can prove "no change".
export async function statFiles(files: readonly TupleFile[]): Promise<Map<string, string> | null> {
  const facts = await Promise.all(files.map(factOf));
  if (facts.includes(undefined)) return null;
  return new Map(files.map((file, i) => [file.path, facts[i]!]));
}
