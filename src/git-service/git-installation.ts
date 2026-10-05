// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { statSync } from "node:fs";
import type { GitReason } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_EXECUTABLE_DIGEST_BYTES, GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { admitGitProbe, MINIMUM_GIT_VERSION } from "./admission";
import { configGlobalPathArgs, configSystemPathArgs } from "./commands";
import { createCollector, isChannelPath, RunnerRefusal, type GitRunner, type IdentityReply, type ProcessContext } from "./git-runner";

// Data-model §1 "Git installation".
export interface GitInstallation {
  gitInstallationId: string;
  // The candidate that the user selected, such as the Git for Windows wrapper `cmd\git.exe`.
  selectedPath: string;
  // The file that runs: `git.exe` in the folder that `--exec-path` printed (contract §3 "Git proposal").
  executablePath: string;
  // `file` is always an identity: a `code` reply refuses registration. T053 compares it with the wider test type.
  executableIdentity: { file: IdentityReply; versionOutput: string; digest: string };
  version: string;
  admission: "admitted";
  // Contract §6 "Startup contexts": the saved version when this startup admitted another version.
  previousVersion?: string;
  // Contract §7 "Configuration file paths": the system lines, then the global lines, as `git var` printed them.
  // An admitted probe always sets it. Only an installation that no probe admitted, such as a test value, lacks it.
  configFiles?: readonly string[];
}

export type GitProbeResult =
  | { ok: true; installation: GitInstallation }
  | { ok: false; gitCode: ErrorCode; detectedVersion?: string; reason?: GitReason; path?: string; minimumVersion: string };

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

// Contract §6 "Startup contexts": a startup failure without a Git file to probe.
const unavailable = (reason: GitReason, path?: string): GitProbeResult => ({
  ok: false,
  gitCode: "GIT_UNAVAILABLE",
  reason,
  ...(path === undefined ? {} : { path }),
  minimumVersion: MINIMUM_GIT_VERSION,
});

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

// Contract §6 "Startup contexts": the installation root is the folder two levels above the selected file.
export function insideInstallation(selected: string, resolved: string): boolean {
  const { path, fold } = NATIVE;
  const relative = path.relative(fold(path.dirname(path.dirname(selected))), fold(resolved));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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
    const step = await probeCandidate(runner, target, operationId, options, target.executablePath);
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

// Contract §7 "Configuration file paths" (git-var(1), Git `builtin/var.c` `cmd_var`): the only parse of `git var` output.
// Exit 0 prints LF-terminated lines that are valid UTF-8. Exit 1 without output means that Git reads no file of that kind.
// Every other result gives null.
export function parseConfigPaths(exitCode: number | null, stdout: Uint8Array, stderrBytes: number): string[] | null {
  if (exitCode === 1) return stdout.length === 0 && stderrBytes === 0 ? [] : null;
  if (exitCode !== 0 || stdout.length === 0 || stdout[stdout.length - 1] !== 0x0a) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout.subarray(0, -1));
  } catch {
    return null;
  }
  const lines = text.split("\n");
  return lines.every((line) => line !== "" && !line.includes("\0")) ? lines : null;
}

// Runs the two `git var` calls in order after the admission checks pass. The shell destroys the context at `register`, so they run before it.
// The first result that `parseConfigPaths` refuses refuses the installation, as an admission check does. A `RunnerRefusal` keeps its code.
async function configPaths(runner: GitRunner, operationId: string, context: ProcessContext, signal: AbortSignal, version: string): Promise<string[] | GitProbeResult> {
  const out: string[] = [];
  for (const args of [configSystemPathArgs(), configGlobalPathArgs()]) {
    const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const exit = await runner.run({ operationId, context, arguments: args, environmentPolicy: "probe", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal });
    // Contract §5: a bootstrap probe deadline gives DEADLINE, as `runProbe` does.
    if (exit.deadline) return failure("DEADLINE");
    if (exit.diagnosticLimit || stdout.limited) return failure("OUTPUT_LIMIT");
    const lines = parseConfigPaths(exit.exitCode, stdout.take(), stderr.bytes);
    if (lines === null) return failure("GIT_UNSUPPORTED", version);
    out.push(...lines);
  }
  return out;
}

// Contract §3 "Git proposal": the native Git file in the folder that `--exec-path` prints. On Windows, the path has backslashes.
// Output without one folder line gives `null`. The service never falls back to the candidate.
function execPathGit(output: string): string | null {
  const folder = /^([^\r\n]+)\r?\n$/.exec(output)?.[1];
  const git = folder === undefined ? null : NATIVE.path.join(folder, NATIVE.gitName);
  return isChannelPath(git) ? git : null;
}

// Contract §6 "Registration bootstrap" `gitProbe`: identity, exec-path, version, architecture, and admission before `gitInstallationId`.
// `selected` is the candidate before a `resolveGit` move. `moved` marks a context that `resolveGit` created. Its exec-path probe must name its own file.
async function probeCandidate(
  runner: GitRunner,
  target: GitProbeTarget,
  operationId: string,
  options: GitProbeOptions,
  selected: string,
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
    // Contract §6 "Startup contexts" gives each startup failure a reason. `chooseGit` keeps GIT_UNSUPPORTED (§3 "Git proposal").
    const startup = !(options.confirm ?? true);
    if (git === null) return startup ? unavailable("resolution-failed") : failure("GIT_UNSUPPORTED");
    if (!isFile(git)) return startup ? unavailable("resolved-missing", git) : failure("GIT_UNSUPPORTED");
    // Without Use this Git, a Git upgrade can move the resolved file only inside the installation root of the selected file.
    if (startup && git !== selected && !insideInstallation(selected, git)) return unavailable("outside-installation");
    if (git !== target.executablePath) {
      if (moved) return failure("GIT_UNSUPPORTED");
      const resolved = await runner.resolveGit({ operationId, bootstrapId: target.bootstrapId, executablePath: git });
      return await probeCandidate(runner, { bootstrapId: resolved.bootstrapId, executablePath: git }, operationId, options, selected, true);
    }
    const versionOutput = await runProbe(runner, operationId, context, ["version", "--build-options"], signal);
    if (typeof versionOutput !== "string") return versionOutput;
    const admitted = admitGitProbe(versionOutput);
    if (!("admission" in admitted) || admitted.admission !== "admitted") return failure(admitted.gitCode, "detectedVersion" in admitted ? admitted.detectedVersion : undefined);
    const version = admitted.detectedVersion;
    const configFiles = await configPaths(runner, operationId, context, signal, version);
    if (!Array.isArray(configFiles)) return configFiles;
    const gitInstallationId = crypto.randomUUID();
    const reply = await runner.register({ operationId, bootstrapId: target.bootstrapId, gitInstallationId, version, digest, confirm: options.confirm ?? true });
    if (reply.result === "another") return { another: { bootstrapId: reply.bootstrapId, executablePath: reply.executablePath } };
    if (reply.result !== "approved") return { ok: false, canceled: true };
    return {
      ok: true,
      installation: {
        gitInstallationId,
        selectedPath: selected,
        executablePath: target.executablePath,
        executableIdentity: { file, versionOutput, digest },
        version,
        admission: "admitted",
        configFiles,
      },
    };
  } catch (error) {
    if (error instanceof RunnerRefusal) return failure(error.code);
    throw error;
  }
}

// A file rewritten in place keeps its file ID, so the digest decides (data-model §1). A change runs nothing.
export async function revalidateGit(_runner: GitRunner, installation: GitInstallation): Promise<GitProbeResult> {
  const read = await fileDigest(installation.executablePath);
  if ("gitCode" in read) return failure(read.gitCode);
  return read.digest === installation.executableIdentity.digest ? { ok: true, installation } : failure("GIT_CHANGED");
}

// Contract §6 "Startup contexts": the handshake `savedGit`. The startup `gitProbe` context binds `selectedPath`.
// The probe resolves the selected file again, so a Git upgrade behind it needs no new confirmation.
// Without a readable selected file, the shell sends no `bootstrapId`.
export async function revalidateSavedGit(
  runner: GitRunner,
  saved: { bootstrapId?: string; selectedPath: string; version: string },
  operationId: string,
): Promise<GitProbeResult> {
  if (saved.bootstrapId === undefined || !isFile(saved.selectedPath)) return unavailable("selected-missing", saved.selectedPath);
  const result = await probeGit(runner, { bootstrapId: saved.bootstrapId, executablePath: saved.selectedPath }, { operationId, confirm: false });
  // Contract §6: a register without `confirm` always replies `approved`.
  if ("canceled" in result) throw new Error("startup Git registration was not approved");
  if (!result.ok || result.installation.version === saved.version) return result;
  return { ok: true, installation: { ...result.installation, previousVersion: saved.version } };
}
