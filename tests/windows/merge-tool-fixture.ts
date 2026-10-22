// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture merge tool of research.md R21 N3, N4, and N6. The `tool` probe of native-facts.test.ts is its program.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processCreationTime } from "../git/win32";

export const PROBE_VARIABLE = "ARBARETO_NATIVE_PROBE";
export const TOOL_NAME = "native-merge-tool.exe";
export const TOOL_READY_MS = 60_000;
const TOOL_SCRIPT = join(import.meta.dir, "native-facts.test.ts");
const POLL_MS = 20;

const slash = (path: string) => path.replaceAll("\\", "/");

// The `mergetool.<tool>.cmd` value. git-mergetool--lib runs it with `eval` and sets `$MERGED`.
export const toolCommand = (tool: string, readyDir: string) => `${PROBE_VARIABLE}=tool '${slash(tool)}' '${slash(TOOL_SCRIPT)}' '${slash(readyDir)}' "$MERGED"`;

// Microsoft PE format: `e_lfanew` at 0x3C, the optional header after the 4-byte signature and the 20-byte COFF header, and `Subsystem` at byte 68 of it.
// The merge tools of git-mergetool(1) are GUI programs, so the copy of the Bun runtime gets the GUI subsystem.
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
export function writeGuiCopy(from: string, to: string): void {
  const image = readFileSync(from);
  const header = image.readUInt32LE(0x3c);
  const subsystem = header + 4 + 20 + 68;
  if (image.toString("latin1", header, header + 4) !== "PE\0\0" || image.readUInt16LE(subsystem) !== IMAGE_SUBSYSTEM_WINDOWS_CUI) throw new Error(`${from} is not a console PE image`);
  image.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystem);
  writeFileSync(to, image);
}

// `job` is the immediate Job of the tool: its members with their creation times, and its `LimitFlags`.
export interface ToolReady {
  pid: number;
  hwnd: number;
  foreground: boolean;
  job: { members: { pid: number; created: string | null }[]; limitFlags: number };
}

export async function waitReady(dir: string, ms = TOOL_READY_MS): Promise<ToolReady | null> {
  for (const end = performance.now() + ms; performance.now() < end; await Bun.sleep(POLL_MS)) {
    const names = readdirSync(dir);
    const error = names.find((n) => n.endsWith(".error"));
    if (error !== undefined) throw new Error(`the fixture tool failed: ${readFileSync(join(dir, error), "utf8")}`);
    const ready = names.find((n) => /^\d+$/.test(n));
    if (ready !== undefined) return JSON.parse(readFileSync(join(dir, ready), "utf8")) as ToolReady;
  }
  return null;
}

export interface Member {
  pid: number;
  name: string | null;
  created: bigint | null;
}

// A PID that still has its recorded creation time is the same process.
export const running = (members: Member[]) => members.filter((m) => m.created !== null && processCreationTime(m.pid) === m.created);

export async function waitEnded(members: Member[], ms: number): Promise<Member[]> {
  for (const end = performance.now() + ms; running(members).length > 0 && performance.now() < end; ) await Bun.sleep(POLL_MS);
  return running(members);
}
