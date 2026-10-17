// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Handshake,
  HandshakeReply,
  MutationReply,
  MutationRequest,
  ProcessReply,
  ProcessRequest,
  TrustRecord,
  TrustReply,
  TrustRequest,
  WslRequest,
} from "./channel";
import {
  ApproveTrustResult,
  ChooseGitResult,
  CloneResult,
  EnvironmentResult,
  LoadHistoryResult,
  NativeFirstEnvelope,
  OpenHistoryResult,
  OpenRecentRepositoryResult,
  OperationResult,
  ProgressEvent,
  ReadComparisonResult,
  ReadEntriesResult,
  ReadHistoryRowsResult,
  ReadRefsResult,
  ReadTrackingResult,
  ReadTrustResult,
  ReadWorkspaceResult,
  RecentRepositoriesResult,
  RegistrationResult,
  RendererEnvelope,
  Response,
  ReviewSyncResult,
  ReviewWorkbenchResult,
  RevokeTrustResult,
  RunWorkbenchResult,
  SearchHistoryResult,
  ServiceEnvelope,
  SessionResult,
  SyncResult,
  SyncSettingsResult,
} from "./envelope";

// Contract §1 "Schemas": `bun run export:schemas` writes these files, and `--check` refuses a stale one.
// `src-tauri/build.rs` generates serde types from the files of the schemas that the shell reads.
export const SCHEMA_DIR = join(import.meta.dir, "schemas");

export const EXPORTED = {
  "renderer-envelope": RendererEnvelope,
  "service-envelope": ServiceEnvelope,
  "native-first-envelope": NativeFirstEnvelope,
  response: Response,
  progress: ProgressEvent,
  "environment-result": EnvironmentResult,
  "choose-git-result": ChooseGitResult,
  "registration-result": RegistrationResult,
  "open-recent-repository-result": OpenRecentRepositoryResult,
  "recent-repositories-result": RecentRepositoriesResult,
  "read-workspace-result": ReadWorkspaceResult,
  "read-entries-result": ReadEntriesResult,
  "open-history-result": OpenHistoryResult,
  "load-history-result": LoadHistoryResult,
  "read-history-rows-result": ReadHistoryRowsResult,
  "search-history-result": SearchHistoryResult,
  "read-refs-result": ReadRefsResult,
  "read-comparison-result": ReadComparisonResult,
  "read-trust-result": ReadTrustResult,
  "approve-trust-result": ApproveTrustResult,
  "revoke-trust-result": RevokeTrustResult,
  "operation-result": OperationResult,
  "session-result": SessionResult,
  // Feature 003 contract Δ3.
  "read-tracking-result": ReadTrackingResult,
  "review-sync-result": ReviewSyncResult,
  "sync-result": SyncResult,
  "clone-result": CloneResult,
  "sync-settings-result": SyncSettingsResult,
  // Feature 004 contract Δ3 and Δ10.
  "review-workbench-result": ReviewWorkbenchResult,
  "run-workbench-result": RunWorkbenchResult,
  handshake: Handshake,
  "handshake-reply": HandshakeReply,
  "trust-record": TrustRecord,
  "process-request": ProcessRequest,
  "process-reply": ProcessReply,
  "mutation-request": MutationRequest,
  "mutation-reply": MutationReply,
  "trust-request": TrustRequest,
  "trust-reply": TrustReply,
  "wsl-request": WslRequest,
} as const;

const SUFFIX = ".schema.json";
const pascal = (name: string) => name.replace(/(^|-)([a-z])/g, (_m, _dash, c: string) => c.toUpperCase());

// typify names the root type from its title. Draft 7 is the draft of schemars 0.8, which typify reads.
export function renderSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EXPORTED).map(([name, schema]) => {
      const json = { ...z.toJSONSchema(schema, { target: "draft-7" }) };
      json.title ??= pascal(name);
      return [name + SUFFIX, JSON.stringify(json, null, 2) + "\n"];
    }),
  );
}

// A checkout can turn LF into CRLF, so the check compares LF text.
export function staleSchemaFiles(dir = SCHEMA_DIR): string[] {
  const expected = renderSchemas();
  let present: string[] = [];
  try {
    present = readdirSync(dir).filter((name) => name.endsWith(SUFFIX));
  } catch {
    // A missing folder makes every file stale.
  }
  const stale = Object.entries(expected)
    .filter(([name, text]) => !present.includes(name) || readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n") !== text)
    .map(([name]) => name);
  return [...stale, ...present.filter((name) => !Object.hasOwn(expected, name))].toSorted();
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const stale = staleSchemaFiles();
    if (stale.length > 0) {
      console.error(`Stale schema files in ${SCHEMA_DIR}: ${stale.join(", ")}. Run bun run export:schemas.`);
      process.exit(1);
    }
    console.log(`Schema files are current: ${SCHEMA_DIR}`);
  } else {
    mkdirSync(SCHEMA_DIR, { recursive: true });
    const files = renderSchemas();
    for (const name of readdirSync(SCHEMA_DIR)) if (name.endsWith(SUFFIX) && !Object.hasOwn(files, name)) rmSync(join(SCHEMA_DIR, name));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(SCHEMA_DIR, name), text);
    console.log(`Wrote ${Object.keys(files).length} schema files to ${SCHEMA_DIR}`);
  }
}
