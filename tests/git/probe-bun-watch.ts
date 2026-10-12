// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T366 probe, not a test. Run: `bun tests/git/probe-bun-watch.ts`. It checks the Bun `fs.watch` behaviour that `src/git-service/watch.ts` handles.
// Windows: check 2. Linux: check 3, the C6 T297 probe. The file imports only Node modules, so it runs alone inside a WSL distro.

import { type FSWatcher, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETTLE_MS = 500;
const WINDOW_MS = 2000;
// libuv `src/win/fs-event.c`: `uv_directory_watcher_buffer_size` is 4096 bytes. Each 60-character name needs more than 120 bytes in `FILE_NOTIFY_INFORMATION`.
const OVERFLOW_FILES = 1000;

console.log(`BUN ${Bun.version} ${Bun.revision} ${process.execPath} ${process.platform}`);
const root = mkdtempSync(join(tmpdir(), "arbareto-probe-watch-"));
console.log(`ROOT ${root}`);

type Seen = { at: number; event: string; name: string | null };
function watched(dir: string): { watcher: FSWatcher; events: Seen[]; errors: string[] } {
  const events: Seen[] = [];
  const errors: string[] = [];
  const watcher = watch(dir, { recursive: true });
  watcher.on("change", (event, name) => events.push({ at: performance.now(), event, name: name === null ? null : String(name) }));
  watcher.on("error", (error) => errors.push(String(error)));
  return { watcher, events, errors };
}

// Removes the watched directory and returns the events after the removal.
async function removal(): Promise<{ after: Seen[]; errors: string[]; removedAt: number }> {
  const dir = join(root, "removed");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "a.txt"), "a\n");
  const w = watched(dir);
  await Bun.sleep(SETTLE_MS);
  const removedAt = performance.now();
  rmSync(dir, { recursive: true, force: true });
  await Bun.sleep(WINDOW_MS);
  w.watcher.close();
  const after = w.events.filter((e) => e.at >= removedAt);
  for (const e of after.slice(0, 10)) console.log(`  +${(e.at - removedAt).toFixed(0)} ms ${e.event} ${e.name === null ? "null" : JSON.stringify(e.name)}`);
  console.log(`  ${after.length} events after removal, ${w.errors.length} errors${w.errors.length > 0 ? `: ${w.errors.join("; ")}` : ""}`);
  return { after, errors: w.errors, removedAt };
}

let failed = false;
const verdict = (check: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`VERDICT ${check} ${ok ? "PASS" : "FAIL"}: ${detail}`);
};

if (process.platform === "win32") {
  console.log("T366 check 2a: remove the watched directory");
  const { after, errors, removedAt } = await removal();
  const late = after.filter((e) => e.at - removedAt >= WINDOW_MS / 2).length;
  verdict("T366-2a", late > 0 && errors.length === 0, `events keep coming without an error after the removal (${late} events in the second half of ${WINDOW_MS} ms, ${errors.length} errors)`);

  console.log(`T366 check 2b: write ${OVERFLOW_FILES} files while the event loop is blocked`);
  const dir = join(root, "overflow");
  mkdirSync(dir);
  const w = watched(dir);
  await Bun.sleep(SETTLE_MS);
  for (let i = 0; i < OVERFLOW_FILES; i++) writeFileSync(join(dir, `${String(i).padStart(6, "0")}-${"x".repeat(53)}`), "x");
  await Bun.sleep(WINDOW_MS);
  w.watcher.close();
  const nulls = w.events.filter((e) => e.name === null);
  console.log(`  ${w.events.length} events, ${nulls.length} with a null name (${nulls.map((e) => e.event).join(", ")}), ${w.errors.length} errors`);
  verdict("T366-2b", nulls.length > 0 && nulls.every((e) => e.event === "change") && w.errors.length === 0, "an overflow gives a change event with a null name");
} else if (process.platform === "linux") {
  console.log("T366 check 3: remove the watched root");
  const { after, errors } = await removal();
  const first = after.findIndex((e) => e.name === null);
  verdict("T366-3", first >= 0 && first === after.length - 1 && errors.length === 0, `a null name, then silence (null at index ${first} of ${after.length}, ${errors.length} errors)`);
} else {
  verdict("T366", false, `no check for ${process.platform}`);
}

rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
