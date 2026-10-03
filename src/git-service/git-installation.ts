// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_EXECUTABLE_DIGEST_BYTES, GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { admitGitProbe, MINIMUM_GIT_VERSION } from "./admission";
import { createCollector, RunnerRefusal, type GitRunner, type IdentityReply, type ProcessContext } from "./git-runner";

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

const failure = (gitCode: ErrorCode, detectedVersion?: string): GitProbeResult => ({
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

// Contract §6 "Registration bootstrap" `gitProbe`: identity, version, architecture, and admission before `gitInstallationId`.
async function probeCandidate(
  runner: GitRunner,
  target: GitProbeTarget,
  operationId: string,
  options: GitProbeOptions,
): Promise<GitProbeResult | GitProbeCanceled | { another: GitProbeTarget }> {
  const context: ProcessContext = { contextKind: "gitProbe", bootstrapId: target.bootstrapId };
  const read = await fileDigest(target.executablePath);
  if ("gitCode" in read) return failure(read.gitCode);
  const digest = read.digest;
  try {
    const [file] = await runner.identities(operationId, context, [target.executablePath]);
    // Contract §6 "Registration bootstrap": a failed identity call refuses registration with UNSUPPORTED_REPOSITORY.
    if ("code" in file) return failure(file.code);
    const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const exit = await runner.run({
      operationId,
      context,
      // Contract §7 "Missing objects": the version probe runs without `--no-lazy-fetch`.
      arguments: ["version", "--build-options"],
      environmentPolicy: "probe",
      limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
      stdout,
      stderr,
      signal: options.signal ?? new AbortController().signal,
    });
    // Contract §5: a bootstrap probe deadline gives DEADLINE.
    if (exit.deadline) return failure("DEADLINE");
    if (exit.diagnosticLimit || stdout.limited) return failure("OUTPUT_LIMIT");
    const versionOutput = exit.exitCode === 0 ? new TextDecoder().decode(stdout.take()) : "";
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
