// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T043 and T044: a Workbench mount for the History inspection keys and the blame dock swap.
// The caller registers the DOM and mocks PatchView and PatchPool before it loads this module.

import { act } from "react";
import type { WorkspaceSnapshot } from "../../src/contracts/envelope";
import type { OnProgress } from "../../src/frontend/bridge";
import { contractChecked, fixtureId } from "./bridge-contract";

const { createRoot } = await import("react-dom/client");
const { ChangesPaneMount, ComparisonViewMount, HistoryViewMount, Workbench } = await import("../../src/frontend/app/Workbench");

type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
export const HEAD = "1".repeat(40);
export const PARENT = "2".repeat(40);
const OIDS = [HEAD, PARENT];
const REGISTRATION = { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) };
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 50))));
const NO_POLL = { setInterval: () => 0, clearInterval: () => {}, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: unknown) => clearTimeout(id as number) };
const HISTORY_CALLS = new Set(["openHistory", "loadHistory", "readHistoryRows", "searchHistory", "closeHistory"]);
export const PATCH = "diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

function snapshot(): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: HEAD },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    location: { kind: "native" },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: 0,
    entries: [],
    cursor: null,
  };
}

/** Mounts the Workbench with an opened repository of two commits. `blame` answers each `readBlame`. */
export async function mountWorkbench(blame: (payload: Record<string, unknown>) => unknown = () => null) {
  const calls: Call[] = [];
  const answered = new WeakSet<object>();
  const bridge = new Proxy({}, { get: (_, name) => (...args: unknown[]) => new Promise((resolve) => calls.push({ operation: String(name), args, resolve })) });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Workbench bridge={contractChecked(bridge) as never} restored={Promise.resolve(succeeded(REGISTRATION)) as never} ChangesPane={ChangesPaneMount} ComparisonView={ComparisonViewMount} HistoryView={HistoryViewMount} clock={NO_POLL} />,
    ),
  );
  await settle();
  let changesId = "";
  // Answers the history, inspection, and blame calls. Other calls stay pending.
  async function serve() {
    const person = { name: "A", email: "a@example.invalid" };
    for (let round = 0; round < 20; round++) {
      const open = calls.filter((c) => !answered.has(c) && (HISTORY_CALLS.has(c.operation) || c.operation === "readCommitChanges" || c.operation === "readCommitFile" || c.operation === "readBlame"));
      if (open.length === 0) return;
      for (const call of open) {
        answered.add(call);
        const payload = call.args[1] as Record<string, unknown> & { at?: Record<string, unknown>; count?: number; text?: string };
        let result: unknown = {};
        if (call.operation === "openHistory")
          result = { viewId: crypto.randomUUID(), scope: payload.scope, generation: 1, head: { state: "branch", target: "refs/heads/main", oid: HEAD }, startCount: 1, refsDigest: "0".repeat(64), shallow: false };
        else if (call.operation === "loadHistory") result = { rows: OIDS.length, complete: true };
        else if (call.operation === "readHistoryRows") {
          const at = payload.at!;
          const first = "row" in at ? (at.row as number) : "oid" in at ? OIDS.indexOf(at.oid as string) : OIDS.length - 1;
          const row = (i: number) => ({
            index: i,
            oid: OIDS[i]!,
            parents: i + 1 < OIDS.length ? [OIDS[i + 1]!] : [],
            cell: { node: 0, color: 0, merge: false, limited: false, segments: [], marks: i + 1 < OIDS.length ? [] : ["root"] },
            labels: [],
            checkout: i === 0,
            ...(payload.text === "none" ? {} : { subject: `Commit ${i}`, author: person, date: 1_700_000_000, encoding: null, invalidUtf8: false }),
            ...(payload.text === "details" ? { body: "", bodyCut: false, committer: person, committerDate: 1_700_000_000, children: [] } : {}),
          });
          const rows = first < 0 || first >= OIDS.length ? [] : Array.from({ length: Math.min(payload.count!, OIDS.length - first) }, (_, k) => row(first + k));
          const counts = { rowCount: OIDS.length, lanes: 1, complete: true, bytes: 1024 };
          result = rows.length === 0 ? { target: "none", ...counts } : { target: "found", rows, cut: false, ...counts };
        } else if (call.operation === "readCommitChanges") {
          changesId = fixtureId(0x6000 + calls.length);
          result = {
            changesId,
            viewId: payload.viewId,
            oid: payload.oid,
            parents: [PARENT],
            base: { kind: "parent", index: 0, oid: PARENT },
            files: [
              { fileId: 0, status: "modified", pathBytes: b64("src/a.txt"), kind: "file" },
              { fileId: 1, status: "modified", pathBytes: b64("z.txt"), kind: "file" },
            ],
            completeness: { state: "complete" },
          };
        } else if (call.operation === "readCommitFile") {
          result = { changesId: payload.changesId, fileId: payload.fileId, facts: {}, binary: false, patch: b64(PATCH), completeness: { state: "complete" } };
        } else if (call.operation === "readBlame") {
          result = blame(payload);
          if (result === null) continue;
        }
        (call.args[2] as OnProgress | undefined)?.({ requestId: "r", operationId: fixtureId(0x7000 + calls.indexOf(call)), state: "accepted", counters: {} } as never);
        await act(async () => call.resolve(succeeded(result)));
      }
      await settle();
    }
    throw new Error("the inspection calls did not settle");
  }
  await serve();
  const readWorkspace = calls.find((c) => c.operation === "readWorkspace")!;
  await act(async () => readWorkspace.resolve(succeeded(snapshot())));
  await settle();
  await serve();
  return {
    calls,
    serve,
    changesId: () => changesId,
    async selectCommit(oid = HEAD) {
      const option = document.querySelector<HTMLElement>(`section[aria-label="History"] [role="option"][data-row-id="${oid}"]`)!;
      await act(async () => option.click());
      await settle();
      await serve();
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
