// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { statSync } from "node:fs";
import { win32 } from "node:path";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_EXECUTABLE_DIGEST_BYTES, GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { admitGitProbe, MINIMUM_GIT_VERSION } from "./admission";
import { createCollector, isChannelPath, RunnerRefusal, type GitRunner, type IdentityReply, type ProcessContext } from "./git-runner";

// Data-model §1 "Git installation".
export interface GitInstallation {
  gitInstallationId: string;
  executablePath: string;
  // `file` is always an identity: a `code` reply refuses registration. T053 compares it with the wider test type.
  executableIdentity: { file: IdentityReply; versionOutput: string; digest: string };
  version: string;
  admission: "admitted";
}

export type GitProbeResult =
  | { ok: true; installation: GitInstallation }
  | { ok: false; gitCode: ErrorCode; detectedVersion?: string; minimumVersion: string };

// The user chose Cancel or Choose another Git in the Git selection confirmation.
export type GitProbeCanceled = { ok: false; canceled: true };

export interface GitProbeTarget {
  bootstrapId: string;
  executablePath: string;
}

export interface GitProbeOptions {
  // The startup probe has no public operation, so it gets an internal ID (contract §6 "Context rules").
  operationId?: string;
  // Contract §6 `register`: `true` shows the native Git selection confirmation.
  confirm?: boolean;
  signal?: AbortSignal;
}

export const failure = (gitCode: ErrorCode, detectedVersion?: string): GitProbeResult => ({
  ok: false,
  gitCode,
  ...(detectedVersion === undefined ? {} : { detectedVersion }),
  minimumVersion: MINIMUM_GIT_VERSION,
});

// Contract §5 "Git executable digest input": a file above the bound gives GIT_UNSUPPORTED. An unreadable file gives GIT_UNAVAILABLE.
async function fileDigest(path: string): Promise<{ digest: string } | { gitCode: ErrorCode }> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of Bun.file(path).stream()) {
      bytes += chunk.byteLength;
      if (bytes > GIT_EXECUTABLE_DIGEST_BYTES) return { gitCode: "GIT_UNSUPPORTED" };
      hasher.update(chunk);
    }
    return { digest: hasher.digest("hex") };
  } catch {
    return { gitCode: "GIT_UNAVAILABLE" };
  }
}

// Contract §6 `register` reply `another` names a new candidate. The same operation probes it.
export async function probeGit(runner: GitRunner, target: GitProbeTarget, options: GitProbeOptions = {}): Promise<GitProbeResult | GitProbeCanceled> {
  const operationId = options.operationId ?? crypto.randomUUID();
  for (;;) {
    const step = await probeCandidate(runner, target, operationId, options);
    if (!("another" in step)) return step;
    if (options.signal?.aborted) return { ok: false, canceled: true };
    target = step.another;
  }
}

// Runs one fixed `gitProbe` command. Contract §7 "Missing objects": a probe runs without `--no-lazy-fetch`.
async function runProbe(
  runner: GitRunner,
  operationId: string,
  context: ProcessContext,
  args: ["--exec-path"] | ["version", "--build-options"],
  signal: AbortSignal,
): Promise<string | GitProbeResult> {
  const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const exit = await runner.run({ operationId, context, arguments: args, environmentPolicy: "probe", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal });
  // Contract §5: a bootstrap probe deadline gives DEADLINE.
  if (exit.deadline) return failure("DEADLINE");
  if (exit.diagnosticLimit || stdout.limited) return failure("OUTPUT_LIMIT");
  return exit.exitCode === 0 ? new TextDecoder().decode(stdout.take()) : "";
}

// Contract §3 "Git proposal": `git.exe` in the folder that `--exec-path` prints, as a fully qualified path with backslashes.
// A missing or non-regular file gives `null`. The service never falls back to the candidate.
function execPathGit(output: string): string | null {
  const folder = /^([^\r\n]+)\r?\n$/.exec(output)?.[1];
  const git = folder === undefined ? null : win32.join(folder, "git.exe");
  return isChannelPath(git) && statSync(git, { throwIfNoEntry: false })?.isFile() ? git : null;
}

// Contract §6 "Registration bootstrap" `gitProbe`: identity, exec-path, version, architecture, and admission before `gitInstallationId`.
// `moved` marks a context that `resolveGit` created. Its exec-path probe must name its own file.
async function probeCandidate(
  runner: GitRunner,
  target: GitProbeTarget,
  operationId: string,
  options: GitProbeOptions,
  moved = false,
): Promise<GitProbeResult | GitProbeCanceled | { another: GitProbeTarget }> {
  const context: ProcessContext = { contextKind: "gitProbe", bootstrapId: target.bootstrapId };
  const signal = options.signal ?? new AbortController().signal;
  const read = await fileDigest(target.executablePath);
  if ("gitCode" in read) return failure(read.gitCode);
  const digest = read.digest;
  try {
    const [file] = await runner.identities(operationId, context, [target.executablePath]);
    // Contract §6 "Registration bootstrap": a failed identity call refuses registration with UNSUPPORTED_REPOSITORY.
    if ("code" in file) return failure(file.code);
    const execPath = await runProbe(runner, operationId, context, ["--exec-path"], signal);
    if (typeof execPath !== "string") return execPath;
    const git = execPathGit(execPath);
    if (git === null) return failure("GIT_UNSUPPORTED");
    if (git !== target.executablePath) {
      // Contract §6 "Startup contexts": the saved path must be the resolved file. Only Use this Git selects another file (FR-003).
      if (!(options.confirm ?? true)) return failure("GIT_CHANGED");
      if (moved) return failure("GIT_UNSUPPORTED");
      const resolved = await runner.resolveGit({ operationId, bootstrapId: target.bootstrapId, executablePath: git });
      return await probeCandidate(runner, { bootstrapId: resolved.bootstrapId, executablePath: git }, operationId, options, true);
    }
    const versionOutput = await runProbe(runner, operationId, context, ["version", "--build-options"], signal);
    if (typeof versionOutput !== "string") return versionOutput;
    const admitted = admitGitProbe(versionOutput);
    if (!("admission" in admitted) || admitted.admission !== "admitted") return failure(admitted.gitCode, "detectedVersion" in admitted ? admitted.detectedVersion : undefined);
    const gitInstallationId = crypto.randomUUID();
    const version = admitted.detectedVersion;
    const reply = await runner.register({ operationId, bootstrapId: target.bootstrapId, gitInstallationId, version, confirm: options.confirm ?? true });
    if (reply.result === "another") return { another: { bootstrapId: reply.bootstrapId, executablePath: reply.executablePath } };
    if (reply.result !== "approved") return { ok: false, canceled: true };
    return {
      ok: true,
      installation: { gitInstallationId, executablePath: target.executablePath, executableIdentity: { file, versionOutput, digest }, version, admission: "admitted" },
    };
  } catch (error) {
    if (error instanceof RunnerRefusal) return failure(error.code);
    throw error;
  }
}

// A file rewritten in place keeps its file ID, so the digest decides (contract §6 "Startup contexts"). A change runs nothing.
export async function revalidateGit(_runner: GitRunner, installation: GitInstallation): Promise<GitProbeResult> {
  const read = await fileDigest(installation.executablePath);
  if ("gitCode" in read) return failure(read.gitCode);
  return read.digest === installation.executableIdentity.digest ? { ok: true, installation } : failure("GIT_CHANGED");
}

// Contract §6 "Startup contexts": the handshake `savedGit`. An equal digest runs the probe in the startup `gitProbe` context.
export async function revalidateSavedGit(runner: GitRunner, saved: GitProbeTarget & { digest: string }, operationId: string): Promise<GitProbeResult> {
  const read = await fileDigest(saved.executablePath);
  if ("gitCode" in read) return failure(read.gitCode);
  if (read.digest !== saved.digest) return failure("GIT_CHANGED");
  const result = await probeGit(runner, saved, { operationId, confirm: false });
  // Contract §6: a register without `confirm` always replies `approved`.
  if ("canceled" in result) throw new Error("startup Git registration was not approved");
  return result;
}
