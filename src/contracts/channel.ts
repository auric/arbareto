// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import {
  BOOTSTRAP_DEADLINE_CAP_MS,
  DAMAGED_MARKER_FILE_NAME_UNITS,
  DAMAGED_MARKERS_PER_HANDSHAKE,
  FILE_FACT_COMPONENT_UNITS,
  FILE_FACT_ENTRIES,
  IDENTITY_PATHS,
  INLINE_PROCESS_INPUT_BYTES,
  PROCESS_EXIT_CODE_MAX,
  RECOVERY_MARKER_BYTES,
  RECOVERY_MARKERS_PER_HANDSHAKE,
  REGISTER_VERSION_BYTES,
  REGISTERED_DEADLINE_CAP_MS,
  STALL_NOTICE_MS,
  STREAMED_PROCESS_INPUT_BYTES,
  SUBMODULE_REVIEW_SUBMODULES,
  SUBMODULE_UPDATE_CEILING_MS,
  SUBMODULE_UPDATE_INACTIVITY_MS,
  TRUST_RECORD_BYTES,
  TRUST_RECORDS,
  WEBVIEW2_VERSION_BYTES,
  WSL_DISTRO_START_MS,
} from "./limits";
import { NATIVE } from "./native-path";
import { ChannelPath, Count, Fingerprint, Identifier, MutationKind, Text } from "./operations";

// Contract §6 "Startup handshake" and "Channel frames". Each union branch has a title, because typify names its types from titles.

const hex = (digits: number) => z.string().regex(new RegExp(`^[0-9a-f]{${digits}}$`));
// Contract §5 bounds a record by the bytes of its JSON encoding. JSON Schema has no byte bound, so each side checks it.
const withinBytes = (max: number) => (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length <= max;

// Contract §6 "Process fields": a Windows identity reply.
export const FileIdentity = z.strictObject({ volumeSerial: hex(16), fileId: hex(32) }).meta({ title: "FileIdentity" });
export type FileIdentity = z.infer<typeof FileIdentity>;
// Contract §11 "Paths and file access": a WSL identity reply. It holds no device number. Any other text is a failed probe.
// `distroGuid`: the `Lxss` subkey name with `A` to `F` folded to lowercase; registry key names ignore letter case.
// `fileSystemId`: GNU `stat --file-system` `%i`, which prints `f_fsid` with `%jx`, so it has no leading zero.
// `inode`: the `stat` `%i` decimal text of a 64-bit inode number.
const INODE = /^[1-9][0-9]{0,19}$/;
export const WslIdentity = z
  .strictObject({
    distroGuid: z.string().regex(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/),
    fileSystemId: z.string().regex(/^[1-9a-f][0-9a-f]{0,15}$/),
    // zod runs a refinement also after a failed pattern check.
    inode: z.string().regex(INODE).refine((value) => INODE.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn),
  })
  .meta({ title: "WslIdentity" });
export type WslIdentity = z.infer<typeof WslIdentity>;
export const PhysicalIdentity = z.union([FileIdentity, WslIdentity]);
export type PhysicalIdentity = z.infer<typeof PhysicalIdentity>;
// One record or marker holds one identity form, and a WSL record holds one distro GUID.
// zod can run a refinement on a value whose fields failed, so the check reads each value defensively.
const oneForm = (identities: readonly unknown[]) => {
  const guids = identities.map((identity) => (typeof identity === "object" && identity !== null && "distroGuid" in identity ? identity.distroGuid : null));
  return guids.every((guid) => guid === null) || guids.every((guid) => guid !== null && guid === guids[0]);
};
// `reason` `absent`: the open failed with `ERROR_FILE_NOT_FOUND` or `ERROR_PATH_NOT_FOUND`. Every other failure carries the code alone.
// A WSL identity probe gives `absent` for `ENOENT` or `ENOTDIR`, and `no-fs-uuid` or `mixed-location` when a contract §11 type rule refuses the path.
export const IdentityReply = z.union([
  FileIdentity,
  WslIdentity,
  z.strictObject({ code: z.literal("UNSUPPORTED_REPOSITORY"), reason: z.enum(["absent", "no-fs-uuid", "mixed-location"]).optional() }).meta({ title: "IdentityRefused" }),
]);
export type IdentityReply = z.infer<typeof IdentityReply>;

// Contract §6 "Startup handshake": UTC times in RFC 3339 form. RFC 3339 §5.6 permits the leap second 60, which `z.iso.datetime` refuses.
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
export const UtcTime = z
  .string()
  .regex(UTC_TIME)
  .refine((value) => {
    // zod runs a refinement also after a failed pattern check.
    const match = UTC_TIME.exec(value);
    if (!match) return false;
    const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60 && s <= 60;
  });

// Contract §6 "Context rules": printable ASCII, as `webView2Version`.
export const VersionText = z.string().max(REGISTER_VERSION_BYTES).regex(/^[\x20-\x7e]*$/);

export const Marker = z
  .strictObject({
    markerId: Identifier,
    kind: MutationKind,
    startedAt: UtcTime,
    worktreeRoot: ChannelPath,
    commonDirectory: ChannelPath,
    commonIdentity: PhysicalIdentity,
  })
  .refine(withinBytes(RECOVERY_MARKER_BYTES));

// Contract §6 "Damaged markers": the file name only, without a path separator.
export const DamagedMarker = z.strictObject({
  markerId: Identifier,
  fileName: z
    .string()
    .min(1)
    .max(DAMAGED_MARKER_FILE_NAME_UNITS)
    .regex(/^[^\\/]*$/)
    .refine((name) => name.length <= DAMAGED_MARKER_FILE_NAME_UNITS),
});

// Contract §7 "Trust approval store": the handshake form, also the `record` of a `confirm` reply.
export const TrustRecord = z
  .strictObject({
    commonDirectory: ChannelPath,
    commonIdentity: PhysicalIdentity,
    worktreeRoot: ChannelPath,
    gitDirectory: ChannelPath,
    worktreeIdentity: z.array(PhysicalIdentity).length(2),
    configurationFingerprint: Fingerprint,
    approvedAt: UtcTime,
    gitSelectedPath: ChannelPath,
  })
  .refine((record) => Array.isArray(record.worktreeIdentity) && oneForm([record.commonIdentity, ...record.worktreeIdentity]))
  .refine(withinBytes(TRUST_RECORD_BYTES));
export type TrustRecord = z.infer<typeof TrustRecord>;

// Without a readable selected file, the shell sends no `bootstrapId` (contract §6 "Startup contexts").
export const SavedGit = z.strictObject({
  bootstrapId: Identifier.optional(),
  selectedPath: ChannelPath,
  executablePath: ChannelPath,
  version: VersionText,
  digest: Fingerprint,
});

export const Handshake = z.strictObject({
  version: z.literal(1),
  restarted: z.boolean(),
  platformScope: z.enum(["qualification-target", "other"]),
  osBuild: Count,
  webView2Version: z.string().max(WEBVIEW2_VERSION_BYTES).regex(/^[\x00-\x7f]*$/),
  // `commit` is a SHA-1 or SHA-256 commit ID.
  buildIdentity: z.strictObject({
    version: VersionText,
    commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:-dirty)?$/),
    signing: z.literal("unsigned"),
  }),
  markers: z.array(Marker).max(RECOVERY_MARKERS_PER_HANDSHAKE),
  unloadedMarkers: Count,
  damagedMarkers: z.array(DamagedMarker).max(DAMAGED_MARKERS_PER_HANDSHAKE),
  trustRecords: z.array(TrustRecord).max(TRUST_RECORDS),
  savedGit: SavedGit.optional(),
});
export type Handshake = z.infer<typeof Handshake>;

export const HandshakeReply = z.union([
  z.strictObject({ sessionId: Identifier }).meta({ title: "HandshakeAccepted" }),
  z.strictObject({ code: z.enum(["INVALID_REQUEST", "PROTOCOL_VERSION"]) }).meta({ title: "HandshakeRefused" }),
]);

// ---- `process` frames ----

const GIT_PROBE = { contextKind: z.literal("gitProbe"), bootstrapId: Identifier };
const DISCOVERY = { contextKind: z.literal("repositoryDiscovery"), bootstrapId: Identifier, gitInstallationId: Identifier };
const REGISTERED = { contextKind: z.literal("registeredOperation"), gitInstallationId: Identifier, repositoryId: Identifier };
// Contract §6 "Channel frames" `run` fields: the context IDs of each context kind.
export const ProcessContext = z.discriminatedUnion("contextKind", [
  z.strictObject(GIT_PROBE).meta({ title: "GitProbeContext" }),
  z.strictObject(DISCOVERY).meta({ title: "DiscoveryContext" }),
  z.strictObject(REGISTERED).meta({ title: "RegisteredContext" }),
]);
export type ProcessContext = z.infer<typeof ProcessContext>;

const ms = (cap: number) => z.int().min(1).max(cap);
// Contract §6 "Channel frames" `limits`. The context and the policy pick the cap.
export const BootstrapLimits = z.strictObject({ deadlineMs: ms(BOOTSTRAP_DEADLINE_CAP_MS) }).meta({ title: "BootstrapLimits" });
export const RegisteredLimits = z
  .strictObject({ deadlineMs: ms(REGISTERED_DEADLINE_CAP_MS), stallMs: z.literal(STALL_NOTICE_MS).optional() })
  .meta({ title: "DeadlineLimits" });
export const NetworkLimits = z
  .strictObject({ inactivityMs: ms(SUBMODULE_UPDATE_INACTIVITY_MS), ceilingMs: ms(SUBMODULE_UPDATE_CEILING_MS), stallMs: z.literal(STALL_NOTICE_MS) })
  .meta({ title: "NetworkLimits" });

// Standard base64 with padding.
export const Base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
// Contract §6: a decoded chunk holds 1 to 65,536 bytes.
export const decodedBytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const InlineInput = Base64.refine((data) => decodedBytes(data) >= 1 && decodedBytes(data) <= INLINE_PROCESS_INPUT_BYTES);

const ENVIRONMENT_POLICIES = ["probe", "read", "mutation", "network"] as const;
export const EnvironmentPolicy = z.enum(ENVIRONMENT_POLICIES);

const call = { callId: Identifier };
const run = {
  type: z.literal("run"),
  ...call,
  operationId: Identifier,
  arguments: z.array(Text),
  input: InlineInput.optional(),
  inputBytes: z.int().min(1).max(STREAMED_PROCESS_INPUT_BYTES).optional(),
  environmentPolicy: EnvironmentPolicy,
  transactionId: Identifier.optional(),
  indexFile: ChannelPath.optional(),
  limits: z.union([RegisteredLimits, NetworkLimits]),
};
const identity = { type: z.literal("identity"), ...call, operationId: Identifier, paths: z.array(ChannelPath).min(1).max(IDENTITY_PATHS) };

// Contract §6 "File facts": one root and its name components. No entry holds an absolute path.
const Component = z
  .string()
  .min(1)
  .max(FILE_FACT_COMPONENT_UNITS)
  .refine((name) => name.length <= FILE_FACT_COMPONENT_UNITS && name.isWellFormed() && NATIVE.isComponent(name));
const FileFactEntry = z.strictObject({ root: z.enum(["worktreeRoot", "gitDirectory", "commonDirectory"]), path: z.array(Component).min(1) });
const fileFacts = { type: z.literal("fileFacts"), ...call, operationId: Identifier, digest: z.boolean(), files: z.array(FileFactEntry).min(1).max(FILE_FACT_ENTRIES) };

// Contract §6 "Channel frames": `executablePath` is the native Git file name in the folder that `--exec-path` printed.
export const GitExecutable = ChannelPath.refine(NATIVE.isGitExecutable);

const registerIds = { operationId: Identifier, bootstrapId: Identifier, gitInstallationId: Identifier };
export const RegisterGitCall = z.strictObject({ ...registerIds, version: VersionText, digest: Fingerprint, confirm: z.boolean() });
export const RegisterRepositoryCall = z.strictObject({
  ...registerIds,
  repositoryId: Identifier,
  worktreeRoot: ChannelPath,
  gitDirectory: ChannelPath,
  commonDirectory: ChannelPath,
});
export type RegisterRequest = z.infer<typeof RegisterGitCall> | z.infer<typeof RegisterRepositoryCall>;
export const ResolveGitCall = z.strictObject({ operationId: Identifier, bootstrapId: Identifier, executablePath: GitExecutable });
export type ResolveGitRequest = z.infer<typeof ResolveGitCall>;
export const ReleaseCall = z.union([
  z.strictObject({ repositoryId: Identifier }).meta({ title: "ReleaseRepository" }),
  z.strictObject({ gitInstallationId: Identifier }).meta({ title: "ReleaseGit" }),
]);

// ---- WSL `process` frames (contract §6 "Channel frames", §11) ----

// Contract §11 "Distro checks": a name that `wsl.exe --list --quiet` prints holds no control character.
export const DistroName = z.string().min(1).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/);
const Guid = WslIdentity.shape.distroGuid;
// An absolute Linux path from the distro.
const LinuxPath = z.string().regex(/^\/[^\u0000]*$/).refine((value) => value.isWellFormed());
// Contract §11 "Git per distro": `<file-system ID>:<inode>:<size>:<modification time>` of the Git file.
const GitFileIdentity = z.string().regex(/^[0-9a-f]+:[0-9]+:[0-9]+:[0-9]+$/);

export const WslDistrosCall = z.strictObject({ operationId: Identifier, bootstrapId: Identifier });
export const WslProbeLimits = z.strictObject({ deadlineMs: ms(WSL_DISTRO_START_MS) }).meta({ title: "WslProbeLimits" });
export const WslProbeCall = z.strictObject({ operationId: Identifier, bootstrapId: Identifier, distro: DistroName, limits: WslProbeLimits });
// Only Use this Git binds the ID, so `confirm` is always true. The shell takes every Git fact from its own probe parse.
export const RegisterWslCall = z.strictObject({ operationId: Identifier, bootstrapId: Identifier, gitInstallationId: Identifier, confirm: z.literal(true) });
export type WslDistrosCall = z.infer<typeof WslDistrosCall>;
export type WslProbeCall = z.infer<typeof WslProbeCall>;
export type RegisterWslCall = z.infer<typeof RegisterWslCall>;

export const WslRegistryKey = z.strictObject({ guid: Guid, name: DistroName, version: Count });
export const WslSavedGit = z.strictObject({ guid: Guid, distro: DistroName, git: LinuxPath, version: VersionText, gitIdentity: GitFileIdentity });
const wslDistros = { type: z.literal("wslDistros"), ...call, path: ChannelPath };
// The reply always holds the context path. Only a path with a WSL prefix adds the list results or the refusal.
export const WslDistrosReply = z.union([
  z.strictObject(wslDistros).meta({ title: "WslDistrosPath" }),
  z
    .strictObject({
      ...wslDistros,
      wslExecutable: ChannelPath,
      listed: z.array(DistroName),
      running: z.array(DistroName),
      keys: z.array(WslRegistryKey),
      saved: z.array(WslSavedGit),
    })
    .meta({ title: "WslDistrosFacts" }),
  z.strictObject({ ...wslDistros, code: z.literal("WSL_UNAVAILABLE"), reason: z.literal("wsl-missing") }).meta({ title: "WslDistrosUnavailable" }),
]);
type WslDistrosFrame = z.infer<typeof WslDistrosReply>;
export type WslDistrosResult = WslDistrosFrame extends infer F ? (F extends unknown ? Omit<F, "type" | "callId"> : never) : never;
export type WslRegistryKey = z.infer<typeof WslRegistryKey>;
export type WslSavedGit = z.infer<typeof WslSavedGit>;

// The WSL request frames. The shell reads them through the types that `src-tauri/build.rs` generates from this union.
export const WslDistrosFrame = z.strictObject({ type: z.literal("wslDistros"), ...call, ...WslDistrosCall.shape }).meta({ title: "WslDistros" });
export const WslProbeFrame = z.strictObject({ type: z.literal("wslProbe"), ...call, ...WslProbeCall.shape }).meta({ title: "WslProbe" });
export const RegisterWslFrame = z.strictObject({ type: z.literal("register"), ...call, ...RegisterWslCall.shape }).meta({ title: "RegisterWsl" });
export const WslRequest = z.union([WslDistrosFrame, WslProbeFrame, RegisterWslFrame]);

export const ProcessRequest = z.union([
  z.strictObject({ ...run, ...GIT_PROBE }).meta({ title: "RunGitProbe" }),
  z.strictObject({ ...run, ...DISCOVERY }).meta({ title: "RunDiscovery" }),
  z.strictObject({ ...run, ...REGISTERED }).meta({ title: "RunRegistered" }),
  z.strictObject({ type: z.literal("input"), ...call, data: InlineInput }).meta({ title: "Input" }),
  z.strictObject({ type: z.literal("cancel"), ...call }).meta({ title: "Cancel" }),
  z.strictObject({ ...identity, ...GIT_PROBE }).meta({ title: "IdentityGitProbe" }),
  z.strictObject({ ...identity, ...DISCOVERY }).meta({ title: "IdentityDiscovery" }),
  z.strictObject({ ...identity, ...REGISTERED }).meta({ title: "IdentityRegistered" }),
  z.strictObject({ ...fileFacts, ...REGISTERED }).meta({ title: "FileFacts" }),
  z.strictObject({ type: z.literal("lingeringCount"), ...call, operationId: Identifier, commonDirectory: ChannelPath }).meta({ title: "LingeringCount" }),
  z.strictObject({ type: z.literal("register"), ...call, ...RegisterGitCall.shape }).meta({ title: "RegisterGit" }),
  z.strictObject({ type: z.literal("register"), ...call, ...RegisterRepositoryCall.shape }).meta({ title: "RegisterRepository" }),
  RegisterWslFrame,
  z.strictObject({ type: z.literal("resolveGit"), ...call, ...ResolveGitCall.shape }).meta({ title: "ResolveGit" }),
  WslDistrosFrame,
  WslProbeFrame,
  z.strictObject({ type: z.literal("release"), repositoryId: Identifier }).meta({ title: "ReleaseRepositoryFrame" }),
  z.strictObject({ type: z.literal("release"), gitInstallationId: Identifier }).meta({ title: "ReleaseGitFrame" }),
  z.strictObject({ type: z.literal("closeJob"), operationId: Identifier }).meta({ title: "CloseJob" }),
]);

// Contract §6 "Process replies": the `refused` codes. The service refuses its own invalid request with INVALID_REQUEST.
export const REFUSED_CODES = ["INVALID_REQUEST", "UNKNOWN_TARGET", "GIT_CHANGED", "PROCESS_OWNERSHIP_FAILED"] as const;
export const Refused = z.strictObject({ type: z.literal("refused"), ...call, code: z.enum(REFUSED_CODES) }).meta({ title: "Refused" });
export const OutputReply = z.strictObject({ type: z.literal("output"), ...call, stream: z.enum(["stdout", "stderr"]), data: Base64 }).meta({ title: "Output" });
export const ActivityReply = z.strictObject({ type: z.literal("activity"), ...call, state: z.enum(["stalled", "active"]) }).meta({ title: "Activity" });
export const InputWrittenReply = z.strictObject({ type: z.literal("inputWritten"), ...call }).meta({ title: "InputWritten" });
export const ExitReply = z
  .strictObject({
    type: z.literal("exit"),
    ...call,
    exitCode: z.int().min(0).max(PROCESS_EXIT_CODE_MAX).nullable(),
    activeDescendants: Count,
    deadline: z.enum(["deadline", "inactivity", "ceiling"]).optional(),
  })
  .meta({ title: "Exit" });
// Contract §6 "Walks": a walk past its §5 deadline replies `deadline` and holds no identity or fact.
const walkDeadline = { ...call, deadline: z.literal("deadline") };
export const IdentityListReply = z.union([
  z.strictObject({ type: z.literal("identity"), ...call, identities: z.array(IdentityReply) }).meta({ title: "IdentityList" }),
  z.strictObject({ type: z.literal("identity"), ...walkDeadline }).meta({ title: "IdentityDeadline" }),
]);
export const LingeringCountReply = z.union([
  z.strictObject({ type: z.literal("lingeringCount"), ...call, count: Count }).meta({ title: "LingeringCountReply" }),
  z.strictObject({ type: z.literal("lingeringCount"), ...walkDeadline }).meta({ title: "LingeringCountDeadline" }),
]);
export const RegisterReply = z.union([
  z.strictObject({ type: z.literal("register"), ...call, result: z.enum(["approved", "declined"]) }).meta({ title: "RegisterResult" }),
  z
    .strictObject({ type: z.literal("register"), ...call, result: z.literal("another"), bootstrapId: Identifier, executablePath: ChannelPath })
    .meta({ title: "RegisterAnother" }),
  z.strictObject({ type: z.literal("register"), ...walkDeadline }).meta({ title: "RegisterDeadline" }),
]);
export const ResolveGitReply = z.union([
  z.strictObject({ type: z.literal("resolveGit"), ...call, bootstrapId: Identifier }).meta({ title: "ResolveGitReply" }),
  z.strictObject({ type: z.literal("resolveGit"), ...walkDeadline }).meta({ title: "ResolveGitDeadline" }),
]);

// Contract §6 "File facts": `lastWrite` is a signed 64-bit integer in decimal.
const STAMP = /^(?:0|-?[1-9][0-9]{0,18})$/;
const Stamp = z
  .string()
  .regex(STAMP)
  // zod runs a refinement also after a failed pattern check, and `BigInt` throws on other text.
  .refine((value) => STAMP.test(value) && BigInt.asIntN(64, BigInt(value)) === BigInt(value));
// Contract §6 "File facts": the codes of a component that exists but cannot be opened or read.
export const FILE_FACT_ERRORS = ["access-denied", "sharing-violation", "io-error", "other-error"] as const;
// `digest` and `bound` exclude each other. A link carries `target` and `relative` exactly when its tag is `symlink` or `junction`.
export const FileFact = z.union([
  z
    .strictObject({
      kind: z.literal("file"),
      size: Count,
      lastWrite: Stamp,
      digest: Fingerprint.optional(),
      bound: z.enum(["file-bytes", "total-bytes"]).optional(),
      // POSIX only. `executable` is the `access(X_OK)` result. `ownerExecute` is the `S_IXUSR` bit of `st_mode`.
      executable: z.boolean().optional(),
      ownerExecute: z.boolean().optional(),
    })
    .refine((fact) => fact.digest === undefined || fact.bound === undefined)
    .meta({ title: "FileFactFile" }),
  z.strictObject({ kind: z.literal("directory"), executable: z.boolean().optional() }).meta({ title: "FileFactDirectory" }),
  z
    .strictObject({
      kind: z.literal("link"),
      component: Count,
      tag: z.enum(["symlink", "junction", "other"]),
      target: Text.optional(),
      relative: z.boolean().optional(),
    })
    .refine((fact) => (fact.tag !== "other") === (fact.target !== undefined) && (fact.target !== undefined) === (fact.relative !== undefined))
    .meta({ title: "FileFactLink" }),
  z.strictObject({ kind: z.literal("absent") }).meta({ title: "FileFactAbsent" }),
  z.strictObject({ kind: z.literal("other") }).meta({ title: "FileFactOther" }),
  z.strictObject({ kind: z.literal("error"), component: Count, code: z.enum(FILE_FACT_ERRORS) }).meta({ title: "FileFactError" }),
]);
export type FileFact = z.infer<typeof FileFact>;
export const FileFactsReply = z.union([
  z.strictObject({ type: z.literal("fileFacts"), ...call, facts: z.array(FileFact).min(1).max(FILE_FACT_ENTRIES) }).meta({ title: "FileFactsReply" }),
  z.strictObject({ type: z.literal("fileFacts"), ...walkDeadline }).meta({ title: "FileFactsDeadline" }),
]);
export const ProcessReply = z.union([
  OutputReply,
  ActivityReply,
  InputWrittenReply,
  ExitReply,
  Refused,
  ...IdentityListReply.options,
  ...LingeringCountReply.options,
  ...RegisterReply.options,
  ...ResolveGitReply.options,
  ...FileFactsReply.options,
  ...WslDistrosReply.options,
]);

// ---- `mutation` frames (contract §6 "Recovery markers") ----

export const StartedCall = z.strictObject({
  operationId: Identifier,
  repositoryId: Identifier,
  kind: MutationKind,
  worktreeRoot: ChannelPath,
  commonDirectory: ChannelPath,
});
export type MutationStarted = z.infer<typeof StartedCall>;

export const MutationRequest = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), ...call, ...StartedCall.shape }).meta({ title: "Started" }),
  z.strictObject({ type: z.literal("ended"), operationId: Identifier, endProcesses: z.boolean() }).meta({ title: "Ended" }),
  z.strictObject({ type: z.literal("resolved"), markerId: Identifier }).meta({ title: "Resolved" }),
]);

const MARKER_FAILURES = ["disk-full", "access-denied", "other"] as const;
export type MarkerFailure = (typeof MARKER_FAILURES)[number];
const started = { type: z.literal("started"), ...call };
export const StartedReply = z.union([
  z.strictObject({ ...started, markerId: Identifier }).meta({ title: "StartedMarker" }),
  z.strictObject({ ...started, busy: z.literal(true) }).meta({ title: "StartedBusy" }),
  // `folder` is the `recovery` folder path.
  z.strictObject({ ...started, failure: z.enum(MARKER_FAILURES), folder: ChannelPath }).meta({ title: "StartedFailure" }),
  z.strictObject({ type: z.literal("started"), ...walkDeadline }).meta({ title: "StartedDeadline" }),
]);
export const MutationReply = z.union([...StartedReply.options, Refused]);

// ---- `trust` frames (contract §7 "Trust approval store") ----

// Contract §7 "Program file digests".
export const TRUST_BOUNDS = ["file-count", "file-bytes", "total-bytes", "link", "name"] as const;
export type TrustBound = (typeof TRUST_BOUNDS)[number];

const confirm = {
  type: z.literal("confirm"),
  worktreeRoot: ChannelPath,
  gitDirectory: ChannelPath,
  commonDirectory: ChannelPath,
  gitSelectedPath: ChannelPath,
  fingerprint: Fingerprint,
  persist: z.boolean(),
  bound: z.enum(TRUST_BOUNDS).optional(),
};
// `bound` comes only with `persist: false`.
const boundRule = (value: { persist: boolean; bound?: string }) => value.persist === (value.bound === undefined);
const revoke = { type: z.literal("revoke"), commonDirectory: ChannelPath };
const confirmRun = {
  type: z.literal("confirmRun"),
  worktreeRoot: ChannelPath,
  submodulePaths: z.array(ChannelPath).min(1).max(SUBMODULE_REVIEW_SUBMODULES),
  programCount: z.int().min(1),
  uncheckedCount: Count,
};
const countRule = (value: { programCount: number; uncheckedCount: number }) => value.uncheckedCount <= value.programCount;

// The runner call form, without `callId`.
export const TrustCall = z.discriminatedUnion("type", [
  z.strictObject(confirm).refine(boundRule).meta({ title: "ConfirmCall" }),
  z.strictObject(revoke).meta({ title: "RevokeCall" }),
  z.strictObject(confirmRun).refine(countRule).meta({ title: "ConfirmRunCall" }),
]);
export type TrustRequest = z.infer<typeof TrustCall>;

export const TrustRequest = z.discriminatedUnion("type", [
  z.strictObject({ ...confirm, ...call }).refine(boundRule).meta({ title: "Confirm" }),
  z.strictObject({ ...revoke, ...call }).meta({ title: "Revoke" }),
  z.strictObject({ ...confirmRun, ...call }).refine(countRule).meta({ title: "ConfirmRun" }),
]);

const reply = (type: "confirm" | "confirmRun" | "revoke") => ({ type: z.literal(type), ...call });
export const ConfirmReply = z.union([
  z.strictObject({ ...reply("confirm"), result: z.literal("declined") }).meta({ title: "ConfirmDeclined" }),
  z.strictObject({ ...reply("confirm"), result: z.literal("approved"), stored: z.literal(false) }).meta({ title: "ConfirmSession" }),
  z.strictObject({ ...reply("confirm"), result: z.literal("approved"), stored: z.literal(true), record: TrustRecord }).meta({ title: "ConfirmStored" }),
]);
export const ConfirmRunReply = z.strictObject({ ...reply("confirmRun"), result: z.enum(["approved", "declined"]) }).meta({ title: "ConfirmRunReply" });
export const RevokeReply = z.union([
  z.strictObject({ ...reply("revoke"), endedProcesses: Count }).meta({ title: "RevokeReply" }),
  z.strictObject({ type: z.literal("revoke"), ...walkDeadline }).meta({ title: "RevokeDeadline" }),
]);
export const TrustReply = z.union([...ConfirmReply.options, ConfirmRunReply, ...RevokeReply.options, Refused]);
