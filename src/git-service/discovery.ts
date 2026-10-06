// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ErrorCode } from "../contracts/errors";
import { COMMIT_OUTPUT_TAIL_BYTES, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { isWindows } from "../contracts/native-path";
import { buildSubmoduleOutputTail } from "../contracts/submodules";
import { hasWslPrefix, wslIdentityPath } from "../contracts/wsl-route";
import { discoveryLayoutArgs, discoveryProfiles, isObjectId, isRefName, refExistsArgs, type ObjectFormat } from "./commands";
import { createCollector, isChannelPath, type Collector, type GitRunner } from "./git-runner";
import { PATH_RESULTS } from "./wsl";

// Data-model §2 and contract §6 "Registration bootstrap": the remedy texts of discovery refusals.
export const DISCOVERY_REMEDIES = {
  bare: "Open a worktree of it, or clone it",
  administrationFolder: "Open the working folder that contains it",
  unavailable: "Run `git status` in this folder",
  // Contract §6 "Dismissal": the remedy of a refused marker dismissal.
  dismissalRefused: "Open this repository and use Refresh.",
} as const;

// git-show-ref(1) `--exists`: the status for a missing reference.
const REF_MISSING_STATUS = 2;

const NEWLINE = 0x0a;
const REF_FORMATS = ["files", "reftable"] as const;
const OBJECT_FORMATS: readonly ObjectFormat[] = ["sha1", "sha256"];

export type RefFormat = (typeof REF_FORMATS)[number];

// Each refusal carries the selected folder when the caller knows it, and a data-model §2 code also carries its text.
// Contract §6 and §9: only the refusal of discovery call 1 carries `outputTail`. No log may hold it.
export interface DiscoveryRefusal {
  code: ErrorCode;
  path?: string;
  remedy?: { text: string };
  outputTail?: string;
  // Contract §11: the reason and the text of a WSL path refusal.
  reason?: "wsl-path" | "mixed-location";
  text?: string;
}

// Data-model §2 `head`: a symbolic target with its object ID, a detached object ID, or a validated unborn branch.
export type DiscoveredHead = { state: "branch"; target: string; oid: string } | { state: "detached"; oid: string } | { state: "unborn"; target: string };

// Data-model §2: the Git-resolved paths, formats, and HEAD. Each path is the text that Git printed.
export interface DiscoveredRepository {
  worktreeRoot: string;
  gitDirectory: string;
  commonDirectory: string;
  indexPath: string;
  objectFormat: ObjectFormat;
  refFormat: RefFormat;
  head: DiscoveredHead;
}

export type DiscoveryResult = { ok: true; repository: DiscoveredRepository } | { ok: false; refusal: DiscoveryRefusal };

export interface DiscoveryTarget {
  operationId: string;
  bootstrapId: string;
  gitInstallationId: string;
  // The folder of the bootstrap context. Only refusals show it. Contract §3: the service payload holds only `bootstrapId`, so the service does not know it.
  directory?: string;
  // Data-model §1 `selectedPath`.
  gitSelectedPath: string;
  signal?: AbortSignal;
  // Contract §11: the distro of a WSL Git. Git then reports Linux paths.
  wsl?: { distro: string };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Contract §9 "Commit failure output": a ring buffer that keeps the last 16 KiB of raw stderr bytes.
function createTailCollector() {
  let kept = new Uint8Array(0);
  let bytes = 0;
  return {
    push(chunk: Uint8Array): void {
      bytes += chunk.length;
      const joined = new Uint8Array(kept.length + chunk.length);
      joined.set(kept);
      joined.set(chunk, kept.length);
      kept = joined.length > COMMIT_OUTPUT_TAIL_BYTES ? joined.slice(joined.length - COMMIT_OUTPUT_TAIL_BYTES) : joined;
    },
    get bytes() {
      return bytes;
    },
    records: 0,
    get limited() {
      return bytes > kept.length;
    },
    outputTail: (): string => buildSubmoduleOutputTail(kept, bytes > kept.length),
  };
}

// Splits LF-terminated output. Returns null when the output does not end with LF.
function outputLines(bytes: Uint8Array): string[] | null {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== NEWLINE) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  return text.slice(0, -1).split("\n");
}

const refusal = (code: ErrorCode, directory: string | undefined, text?: string): DiscoveryRefusal => ({
  code,
  ...(directory === undefined ? {} : { path: directory }),
  ...(text === undefined ? {} : { remedy: { text } }),
});
const unavailable = (directory: string | undefined) => refusal("REPOSITORY_UNAVAILABLE", directory, DISCOVERY_REMEDIES.unavailable);

interface QueryResult {
  exitCode: number | null;
  stdout: Uint8Array;
  // Every stderr byte that Git wrote, also the bytes past the collector bound.
  stderrBytes: number;
}

// Runs one fixed discovery query under the `probe` policy. A `RunnerRefusal` keeps its own code and rejects the call.
async function query(
  runner: GitRunner,
  target: DiscoveryTarget,
  args: string[],
  signal: AbortSignal,
  stderr: Collector = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
): Promise<QueryResult | DiscoveryRefusal> {
  const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const exit = await runner.run({
    operationId: target.operationId,
    context: { contextKind: "repositoryDiscovery", bootstrapId: target.bootstrapId, gitInstallationId: target.gitInstallationId },
    arguments: args,
    environmentPolicy: "probe",
    limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
    stdout,
    stderr,
    signal,
  });
  // Contract §5 and §9: a probe past its deadline gives DEADLINE. Over 4 MiB of diagnostics, a read ends with OUTPUT_LIMIT.
  if (exit.deadline) return refusal("DEADLINE", target.directory);
  if (signal.aborted) return refusal("CANCELED", target.directory);
  if (exit.diagnosticLimit || stdout.limited) return refusal("OUTPUT_LIMIT", target.directory);
  return { exitCode: exit.exitCode, stdout: stdout.take(), stderrBytes: stderr.bytes };
}

const isRefusal = (value: QueryResult | DiscoveryRefusal): value is DiscoveryRefusal => "code" in value;

// Research R2 "T283 record": the two-call form, then `symbolic-ref` and `show-ref` for HEAD.
// Contract §6: every nonzero exit of the first call gives the merged REPOSITORY_UNAVAILABLE with `outputTail`. Git prints no machine-readable reason, so no stderr byte decides.
// No query loads the index, because an index load can run `core.fsmonitor` before trust approval.
export async function discoverRepository(runner: GitRunner, target: DiscoveryTarget): Promise<DiscoveryResult> {
  const signal = target.signal ?? new AbortController().signal;
  const fail = (value: DiscoveryRefusal): DiscoveryResult => ({ ok: false, refusal: value });
  const profiles = discoveryProfiles();
  const [flagsArgs, symbolicArgs, headArgs] = [profiles[0]!, profiles[7]!, profiles[8]!];

  const tail = createTailCollector();
  const flags = await query(runner, target, flagsArgs, signal, tail);
  if (isRefusal(flags)) return fail(flags);
  if (flags.exitCode !== 0) return fail({ ...unavailable(target.directory), outputTail: tail.outputTail() });
  const [bare, inside, ...extra] = outputLines(flags.stdout) ?? [];
  if (extra.length > 0 || !isBoolean(bare) || !isBoolean(inside)) return fail(unavailable(target.directory));
  if (bare === "true") return fail(refusal("UNSUPPORTED_REPOSITORY", target.directory, DISCOVERY_REMEDIES.bare));
  if (inside === "true") return fail(refusal("UNSUPPORTED_REPOSITORY", target.directory, DISCOVERY_REMEDIES.administrationFolder));

  const layout = await query(runner, target, discoveryLayoutArgs(), signal);
  if (isRefusal(layout)) return fail(layout);
  if (layout.exitCode !== 0) return fail(unavailable(target.directory));
  const values = outputLines(layout.stdout);
  if (values === null || values.length !== 6) return fail(unavailable(target.directory));
  const [objectFormat, refFormat] = values.slice(4) as [string, string];
  let resolved = values.slice(0, 4);
  if (target.wsl) {
    // Contract §11 "Paths and file access": Linux Git reports Linux paths. Each one becomes its UNC identity.
    if (!resolved.every((path) => path.startsWith("/"))) return fail(unavailable(target.directory));
    const converted = resolved.map((path) => wslIdentityPath(target.wsl!.distro, path));
    if (converted.some((path) => path === null)) return fail({ code: "UNSUPPORTED_REPOSITORY", ...PATH_RESULTS["wsl-path"] });
    resolved = converted as string[];
  }
  const [worktreeRoot, gitDirectory, commonDirectory, indexPath] = resolved as [string, string, string, string];
  if (![worktreeRoot, gitDirectory, commonDirectory, indexPath].every((path) => isChannelPath(path))) return fail(unavailable(target.directory));
  // Contract §11: a Windows repository whose Git-resolved directories lie under a WSL prefix.
  if (!target.wsl && isWindows && [worktreeRoot, gitDirectory, commonDirectory].some(hasWslPrefix)) return fail({ code: "UNSUPPORTED_REPOSITORY", ...PATH_RESULTS["mixed-location"] });
  if (!OBJECT_FORMATS.includes(objectFormat as ObjectFormat) || !(REF_FORMATS as readonly string[]).includes(refFormat)) return fail(unavailable(target.directory));

  const head = await readHead(runner, target, symbolicArgs, headArgs, objectFormat as ObjectFormat, signal);
  if ("code" in head) return fail(head);
  return {
    ok: true,
    repository: { worktreeRoot, gitDirectory, commonDirectory, indexPath, objectFormat: objectFormat as ObjectFormat, refFormat: refFormat as RefFormat, head },
  };
}

// Contract §6: only the merged refusal of discovery call 1 carries `outputTail`, so its presence marks a nonzero exit of that call.
export const isMergedRefusal = (value: DiscoveryRefusal): boolean => value.code === "REPOSITORY_UNAVAILABLE" && value.outputTail !== undefined;

const isBoolean = (value: string | undefined): value is "true" | "false" => value === "true" || value === "false";

// git-symbolic-ref(1) `-q`: exit 0 gives the target. A detached HEAD gives a non-zero status silently, so only exit 1 with no stdout and no stderr byte is detached.
// Contract §6: after a failed `show-ref --head --verify HEAD`, the exit status of `show-ref --exists <target>` tells an unborn branch from a failed lookup. No stderr byte decides.
async function readHead(
  runner: GitRunner,
  target: DiscoveryTarget,
  symbolicArgs: string[],
  headArgs: string[],
  objectFormat: ObjectFormat,
  signal: AbortSignal,
): Promise<DiscoveredHead | DiscoveryRefusal> {
  const symbolic = await query(runner, target, symbolicArgs, signal);
  if (isRefusal(symbolic)) return symbolic;
  let ref: string | null = null;
  if (symbolic.exitCode === 0) {
    const out = outputLines(symbolic.stdout);
    if (out === null || out.length !== 1 || !isRefName(out[0]!)) return unavailable(target.directory);
    ref = out[0]!;
  } else if (symbolic.exitCode !== 1 || symbolic.stdout.length > 0 || symbolic.stderrBytes > 0) {
    return unavailable(target.directory);
  }

  const resolved = await query(runner, target, headArgs, signal);
  if (isRefusal(resolved)) return resolved;
  if (resolved.exitCode === 0) {
    const out = outputLines(resolved.stdout);
    const match = out?.length === 1 ? /^(\S+) HEAD$/.exec(out[0]!) : null;
    if (match === null || !isObjectId(match[1]!, objectFormat)) return unavailable(target.directory);
    return ref === null ? { state: "detached", oid: match[1]! } : { state: "branch", target: ref, oid: match[1]! };
  }
  if (ref === null) return unavailable(target.directory);
  const exists = await query(runner, target, refExistsArgs(ref), signal);
  if (isRefusal(exists)) return exists;
  if (exists.exitCode === REF_MISSING_STATUS && exists.stdout.length === 0) return { state: "unborn", target: ref };
  return unavailable(target.directory);
}
