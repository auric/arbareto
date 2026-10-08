// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §12 "Review reads". T229 adds `reviewSubmodules` here.

import { gitmodulesHeadArgs, gitmodulesIndexArgs, gitmodulesListArgs, type ObjectFormat } from "./commands";

const GITMODULES = Buffer.from(".gitmodules");

export interface GitmodulesIndexEntry {
  path: Uint8Array;
  stage: number;
  oid: string;
}

// The `.gitmodules` source in Git's order (Git `submodule-config.c` `config_from_gitmodules`): the worktree file, the stage-0 index blob, then the HEAD blob.
// Null: no source exists. `headHas` runs only when the first two sources are absent, and a value other than a boolean passes through.
export async function gitmodulesSource<S>(
  worktreeEntry: boolean,
  index: readonly GitmodulesIndexEntry[],
  objectFormat: ObjectFormat,
  headHas: () => Promise<boolean | S>,
): Promise<string[] | null | S> {
  if (worktreeEntry) return gitmodulesListArgs();
  const staged = index.find((e) => e.stage === 0 && GITMODULES.equals(e.path));
  if (staged !== undefined) return gitmodulesIndexArgs(staged.oid, objectFormat);
  const head = await headHas();
  if (head === true) return gitmodulesHeadArgs();
  return head === false ? null : head;
}
