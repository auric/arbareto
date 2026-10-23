// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { DIFF_THEME } from "../highlight/set";

// research.md R9: two local workers and the Shiki JavaScript engine, so no WebAssembly compiles.
const POOL = { workerFactory: () => new Worker(WorkerUrl, { type: "module" }), poolSize: 2 };
const HIGHLIGHTER = { preferredHighlighter: "shiki-js", theme: DIFF_THEME } as const;

/** The Pierre worker pool. Pierre keeps one pool and ends it when its last provider unmounts, so one childless instance stays mounted session-wide, from the first diff of either view. */
export default function PatchPool({ children }: { children?: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      {children}
    </WorkerPoolContextProvider>
  );
}
