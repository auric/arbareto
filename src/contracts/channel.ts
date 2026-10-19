// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import {
  BOOTSTRAP_DEADLINE_CAP_MS,
  COMPARED_RAW_VERSION_BYTES,
  DAMAGED_MARKER_FILE_NAME_UNITS,
  DAMAGED_MARKERS_PER_HANDSHAKE,
  FILE_FACT_COMPONENT_UNITS,
  FILE_FACT_ENTRIES,
  IDENTITY_PATHS,
  INLINE_PROCESS_INPUT_BYTES,
  MUTATION_RAW_INDEX_BYTES,
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
  WHOLE_FILE_STAGE_INPUT_BYTES,
  WSL_DISTRO_START_MS,
} from "./limits";
import { PUTTY_PROGRAMS, PUTTY_UNAVAILABLE_REASONS } from "./errors";
import { NATIVE } from "./native-path";
import { ChannelPath, ConfigScope, Count, Direction, DistroName, FileDirection, Fingerprint, Identifier, MutationKind, Text } from "./operations";

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

const oneRecordForm = (record: { commonIdentity: unknown; worktreeIdentity: unknown }) => Array.isArray(record.worktreeIdentity) && oneForm([record.commonIdentity, ...record.worktreeIdentity]);
// Contract §7 "Trust approval store": the feature 001 record. Feature 004 plan.md O-5: the handshake still carries it, and it gives `changed`.
export const TrustRecordV1 = z
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
  .refine(oneRecordForm)
  .refine(withinBytes(TRUST_RECORD_BYTES))
  .meta({ title: "TrustRecordV1" });
// Feature 004 data-model §10: the record binds the folders, their identities, and the selected Git path. It holds no fingerprint and no program digest.
// `worktreeIdentity` holds the worktree root identity, then the administration-directory identity.
export const TrustRecordV2 = z
  .strictObject({
    policyVersion: z.literal(2),
    commonDirectory: ChannelPath,
    commonIdentity: PhysicalIdentity,
    worktreeRoot: ChannelPath,
    adminDirectory: ChannelPath,
    worktreeIdentity: z.array(PhysicalIdentity).length(2),
    gitSelectedPath: ChannelPath,
    approvedAt: UtcTime,
  })
  .refine(oneRecordForm)
  .refine(withinBytes(TRUST_RECORD_BYTES))
  .meta({ title: "TrustRecordV2" });
export type TrustRecordV2 = z.infer<typeof TrustRecordV2>;
// The handshake form.
export const TrustRecord = z.union([TrustRecordV1, TrustRecordV2]);
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
// Feature 003 contract Δ6: the shell binds the destination of one clone. The cwd is the application-owned launch folder, or `/` in WSL.
const CLONE = { contextKind: z.literal("clone"), cloneId: Identifier, gitInstallationId: Identifier };
// Feature 004 contract Δ6: `globalConfig` runs the fixed configuration arrays in the application-owned launch folder.
const GLOBAL_CONFIG = { contextKind: z.literal("globalConfig"), gitInstallationId: Identifier };
// Feature 004 contract Δ6: the native step of the `worktree-add` review binds the path to `bootstrapId`.
const WORKTREE_ADD = { contextKind: z.literal("worktreeAdd"), gitInstallationId: Identifier, repositoryId: Identifier, bootstrapId: Identifier };
// Contract §6 "Channel frames" `run` fields: the context IDs of each context kind.
export const ProcessContext = z.discriminatedUnion("contextKind", [
  z.strictObject(GIT_PROBE).meta({ title: "GitProbeContext" }),
  z.strictObject(DISCOVERY).meta({ title: "DiscoveryContext" }),
  z.strictObject(REGISTERED).meta({ title: "RegisteredContext" }),
  z.strictObject(CLONE).meta({ title: "CloneContext" }),
  z.strictObject(GLOBAL_CONFIG).meta({ title: "GlobalConfigContext" }),
  z.strictObject(WORKTREE_ADD).meta({ title: "WorktreeAddContext" }),
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
// Feature 004 contract Δ5 and Δ6: the policy `mergetool` has no inactivity limit and the 4-hour ceiling.
export const CeilingLimits = z.strictObject({ ceilingMs: ms(SUBMODULE_UPDATE_CEILING_MS) }).meta({ title: "CeilingLimits" });

// Standard base64 with padding.
export const Base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
// Contract §6: a decoded chunk holds 1 to 65,536 bytes.
export const decodedBytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const InlineInput = Base64.refine((data) => decodedBytes(data) >= 1 && decodedBytes(data) <= INLINE_PROCESS_INPUT_BYTES);

// Feature 003 contract Δ6 and Δ7: `remote` and `integrate` take the network limits. Feature 004 contract Δ7: `mergetool` takes the ceiling limits.
const ENVIRONMENT_POLICIES = ["probe", "read", "mutation", "network", "search", "remote", "integrate", "mergetool"] as const;
// The `id` gives the shell one generated `EnvironmentPolicy` type for the three `run` context kinds.
export const EnvironmentPolicy = z.enum(ENVIRONMENT_POLICIES).meta({ id: "EnvironmentPolicy" });

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
  limits: z.union([RegisteredLimits, NetworkLimits, CeilingLimits]),
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

// ---- WSL file work (contract §6 "WSL file work", "Index digest in a read") ----

// The object ID of a SHA-1 or a SHA-256 repository.
const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
// A decimal `st_dev` or `st_ino` text of a 64-bit value.
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const Decimal = z
  .string()
  .regex(U64)
  // zod runs a refinement also after a failed pattern check.
  .refine((value) => U64.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn);
// Contract §6 "Channel frames" `indexFile`: a candidate index name, one component in the Git directory.
const CandidateName = Component.refine((name) => name.startsWith("arbareto-candidate-"));
// Contract §4 "WSL index publication": the lock content, 32 random bytes of the service as 64 lowercase hex digits.
const LockToken = Fingerprint;
// The device and inode of the `lock` reply.
const LockIdentity = z.strictObject({ device: Decimal, inode: Decimal });
// `sharedIndex`: the hash of the `link` extension that the service parsed last.
export const WslIndexRequest = z.strictObject({ sharedIndex: ObjectId.optional() });
// The byte value of each bound name (contract §5).
export const WSL_FILE_BOUNDS = { COMPARED_RAW_VERSION_BYTES, WHOLE_FILE_STAGE_INPUT_BYTES, MUTATION_RAW_INDEX_BYTES } as const;
const INDEX_BOUND = { bound: z.literal("MUTATION_RAW_INDEX_BYTES") };
const WHOLE_BOUND = { bound: z.literal("WHOLE_FILE_STAGE_INPUT_BYTES") };
const WorktreeEntry = z.strictObject({ root: z.literal("worktreeRoot"), path: z.array(Component).min(1) });
const wslFiles = { type: z.literal("wslFiles"), ...call, operationId: Identifier, ...REGISTERED };
// typify tags the group by `mode`, because each branch has its own `mode` value.
export const WslFilesGroup = z
  .union([
    z
      .strictObject({
        ...wslFiles,
        mode: z.literal("digest"),
        bound: z.enum(["COMPARED_RAW_VERSION_BYTES", "WHOLE_FILE_STAGE_INPUT_BYTES"]),
        files: z.array(FileFactEntry).min(1).max(FILE_FACT_ENTRIES),
      })
      // `WHOLE_FILE_STAGE_INPUT_BYTES` takes exactly one entry. zod can run a refinement on a value whose fields failed.
      .refine((r) => r.bound !== "WHOLE_FILE_STAGE_INPUT_BYTES" || (Array.isArray(r.files) && r.files.length === 1))
      .meta({ title: "WslFilesDigest" }),
    z.strictObject({ ...wslFiles, mode: z.literal("indexDigest"), ...INDEX_BOUND, sharedIndex: ObjectId.optional() }).meta({ title: "WslFilesIndexDigest" }),
    z.strictObject({ ...wslFiles, mode: z.literal("hashObject"), ...WHOLE_BOUND, files: z.array(WorktreeEntry).length(1) }).meta({ title: "WslFilesHashObject" }),
    z
      .strictObject({ ...wslFiles, mode: z.literal("catFile"), ...WHOLE_BOUND, files: z.array(WorktreeEntry).length(1), oid: ObjectId, size: z.int().min(0).max(WHOLE_FILE_STAGE_INPUT_BYTES) })
      .meta({ title: "WslFilesCatFile" }),
    z.strictObject({ ...wslFiles, mode: z.literal("lock"), ...INDEX_BOUND, token: LockToken }).meta({ title: "WslFilesLock" }),
    z.strictObject({ ...wslFiles, mode: z.literal("candidate"), ...INDEX_BOUND, candidate: CandidateName }).meta({ title: "WslFilesCandidate" }),
    z
      .strictObject({
        ...wslFiles,
        mode: z.literal("publish"),
        ...INDEX_BOUND,
        candidate: CandidateName,
        lock: LockIdentity,
        token: LockToken,
        expected: Fingerprint,
      })
      .meta({ title: "WslFilesPublish" }),
    // The owned lock by the device and inode of the `lock` reply and its `token`, the lock by its `token` alone when no `lock` reply exists,
    // or a candidate by the digest that the service verified last.
    z
      .strictObject({
        ...wslFiles,
        mode: z.literal("remove"),
        ...INDEX_BOUND,
        lock: LockIdentity.optional(),
        token: LockToken.optional(),
        candidate: CandidateName.optional(),
        expected: Fingerprint.optional(),
      })
      .refine((r) => (r.token !== undefined && r.candidate === undefined && r.expected === undefined) || (r.lock === undefined && r.token === undefined && r.candidate !== undefined && r.expected !== undefined))
      .meta({ title: "WslFilesRemove" }),
  ])
  .meta({ title: "WslFilesGroup" });
type WslFilesFrame = z.infer<typeof WslFilesGroup>;
// The frame without `type` and `callId`, for each mode.
export type WslFilesCall = WslFilesFrame extends infer F ? (F extends unknown ? Omit<F, "type" | "callId"> : never) : never;

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

const Guid = WslIdentity.shape.distroGuid;
// An absolute Linux path from the distro.
export const LinuxPath = z.string().regex(/^\/[^\u0000]*$/).refine((value) => value.isWellFormed());
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

// typify tags a union by `type` only when each branch has its own `type` value (research.md "T323 typify gate").
// So each root is a `z.xor` with one titled group union for each `type` value that has more than one shape.
// The shell reads the `type` value first and then parses its group type.
// typify names an object branch of a union only when the branch is in `definitions`. An `id` puts it there.
const named = <T extends z.ZodType>(title: string, schema: T) => schema.meta({ id: title, title });

export const ProcessRequest = z.xor([
  z.union([
    z.strictObject({ ...run, ...GIT_PROBE }).meta({ title: "RunGitProbe" }),
    z.strictObject({ ...run, ...DISCOVERY }).meta({ title: "RunDiscovery" }),
    // Feature 002 contract Δ6: only a registered run takes `script`.
    z.strictObject({ ...run, ...REGISTERED, script: z.literal("matchingProbe").optional() }).meta({ title: "RunRegistered" }),
    // Feature 003 contract Δ6: the shell admits only the fixed clone array with the bound destination as the last item.
    z.strictObject({ ...run, ...CLONE }).meta({ title: "RunClone" }),
    // Feature 004 contract Δ6: the shell admits only the fixed arrays of each context.
    z.strictObject({ ...run, ...GLOBAL_CONFIG }).meta({ title: "RunGlobalConfig" }),
    z.strictObject({ ...run, ...WORKTREE_ADD }).meta({ title: "RunWorktreeAdd" }),
  ]).meta({ title: "RunGroup" }),
  named("Input", z.strictObject({ type: z.literal("input"), ...call, data: InlineInput })),
  named("Cancel", z.strictObject({ type: z.literal("cancel"), ...call })),
  z.union([
    z.strictObject({ ...identity, ...GIT_PROBE }).meta({ title: "IdentityGitProbe" }),
    z.strictObject({ ...identity, ...DISCOVERY }).meta({ title: "IdentityDiscovery" }),
    z.strictObject({ ...identity, ...REGISTERED }).meta({ title: "IdentityRegistered" }),
  ]).meta({ title: "IdentityGroup" }),
  named(
    "FileFacts",
    z
      .strictObject({ ...fileFacts, ...REGISTERED, index: WslIndexRequest.optional() })
      // Only a request with `digest: false` takes `index`.
      .refine((r) => r.index === undefined || r.digest === false),
  ),
  named("LingeringCount", z.strictObject({ type: z.literal("lingeringCount"), ...call, operationId: Identifier, commonDirectory: ChannelPath })),
  z.union([
    z.strictObject({ type: z.literal("register"), ...call, ...RegisterGitCall.shape }).meta({ title: "RegisterGit" }),
    z.strictObject({ type: z.literal("register"), ...call, ...RegisterRepositoryCall.shape }).meta({ title: "RegisterRepository" }),
    RegisterWslFrame,
  ]).meta({ title: "RegisterGroup" }),
  named("ResolveGit", z.strictObject({ type: z.literal("resolveGit"), ...call, ...ResolveGitCall.shape })),
  WslDistrosFrame,
  WslProbeFrame,
  WslFilesGroup,
  z.union([
    z.strictObject({ type: z.literal("release"), repositoryId: Identifier }).meta({ title: "ReleaseRepositoryFrame" }),
    z.strictObject({ type: z.literal("release"), gitInstallationId: Identifier }).meta({ title: "ReleaseGitFrame" }),
  ]).meta({ title: "ReleaseGroup" }),
  named("CloseJob", z.strictObject({ type: z.literal("closeJob"), operationId: Identifier })),
  // Feature 003 contract Δ6. Feature 004 contract Δ6: the `worktreeAdd` binding also takes it.
  z.union([
    z.strictObject({ type: z.literal("destinationFacts"), ...call, operationId: Identifier, cloneId: Identifier }).meta({ title: "DestinationFactsClone" }),
    z.strictObject({ type: z.literal("destinationFacts"), ...call, operationId: Identifier, bootstrapId: Identifier }).meta({ title: "DestinationFactsWorktreeAdd" }),
  ]).meta({ title: "DestinationFactsGroup" }),
  z.union([
    z.strictObject({ type: z.literal("pageant"), ...call, operationId: Identifier, repositoryId: Identifier, remote: Text.min(1) }).meta({ title: "PageantRemote" }),
    z.strictObject({ type: z.literal("pageant"), ...call, operationId: Identifier, cloneId: Identifier }).meta({ title: "PageantClone" }),
  ]).meta({ title: "PageantGroup" }),
  // The shell takes the Git path from `gitInstallationId` and the worktree root from `repositoryId`. A clone target has no repository.
  named("Terminal", z.strictObject({ type: z.literal("terminal"), ...call, operationId: Identifier, gitInstallationId: Identifier, repositoryId: Identifier.optional(), target: Text.min(1) })),
  // Feature 004 contract Δ6. `expected` is `absent`, or the size and SHA-256 of the target (data-model §7).
  named(
    "FileAppend",
    z.strictObject({
      type: z.literal("fileAppend"),
      ...call,
      operationId: Identifier,
      repositoryId: Identifier,
      target: z.enum(["gitignore", "exclude"]),
      path: ChannelPath,
      expected: z.union([z.enum(["absent"]), z.strictObject({ size: Count, sha256: Fingerprint }).meta({ title: "FileAppendExpected" })]),
      bytes: InlineInput,
    }),
  ),
  named("Reveal", z.strictObject({ type: z.literal("reveal"), ...call, operationId: Identifier, repositoryId: Identifier, path: ChannelPath })),
]);

// Contract §6 "Process replies": the `refused` codes. The service refuses its own invalid request with INVALID_REQUEST.
export const REFUSED_CODES = ["INVALID_REQUEST", "UNKNOWN_TARGET", "GIT_CHANGED", "PROCESS_OWNERSHIP_FAILED"] as const;
export const Refused = z.strictObject({ type: z.literal("refused"), ...call, code: z.enum(REFUSED_CODES) }).meta({ title: "Refused" });
export const OutputReply = z.strictObject({ type: z.literal("output"), ...call, stream: z.enum(["stdout", "stderr"]), data: Base64 })
  // The `id` gives the shell a named `Output` struct. The shell checks its hand-built `output` reply against it in a test.
  .meta({ id: "Output", title: "Output" });
export const ActivityReply = z.strictObject({ type: z.literal("activity"), ...call, state: z.enum(["stalled", "active"]) }).meta({ title: "Activity" });
export const InputWrittenReply = z.strictObject({ type: z.literal("inputWritten"), ...call }).meta({ title: "InputWritten" });
export const ExitReply = z
  .strictObject({
    type: z.literal("exit"),
    ...call,
    exitCode: z.int().min(0).max(PROCESS_EXIT_CODE_MAX).nullable(),
    // Contract §6 "Channel frames": null when the shell has no count. Null is never a process-end fact.
    activeDescendants: Count.nullable(),
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

// ---- WSL file work results (contract §6 "WSL file work") ----

// A WSL walk gives only the POSIX codes.
const WSL_FILE_ERRORS = ["access-denied", "io-error", "other-error"] as const;
const WslFileError = z.strictObject({ kind: z.literal("error"), component: Count, code: z.enum(WSL_FILE_ERRORS) }).meta({ title: "WslFileError" });
// `$?` after `close` (perlvar): the exit status, or the signal number.
const WslExit = z.union([
  z.strictObject({ exitCode: z.int().min(0).max(255) }).meta({ title: "WslExitCode" }),
  z.strictObject({ signal: z.int().min(1).max(127) }).meta({ title: "WslExitSignal" }),
]).meta({ id: "WslExit", title: "WslExit" });
// A link target holds 1 to 4,095 raw bytes (contract §5 "WSL file work").
const TargetBytes = Base64.refine((data) => decodedBytes(data) >= 1 && decodedBytes(data) <= 4095);
export const WslIndexPart = z.union([
  z.strictObject({ kind: z.literal("digest"), size: Count, sha256: Fingerprint }).meta({ title: "WslIndexDigestPart" }),
  z.strictObject({ kind: z.literal("absent") }).meta({ title: "WslIndexAbsent" }),
  z.strictObject({ kind: z.literal("bound") }).meta({ title: "WslIndexBound" }),
  z.strictObject({ kind: z.literal("error"), code: z.enum(WSL_FILE_ERRORS) }).meta({ title: "WslIndexError" }),
]).meta({ id: "WslIndexPart", title: "WslIndexPart" });
export type WslIndexPart = z.infer<typeof WslIndexPart>;
const WslIndexDigest = z.strictObject({ kind: z.literal("index"), index: WslIndexPart, sharedIndex: WslIndexPart.optional() }).meta({ title: "WslIndexDigest" });
// The `index` of a `fileFacts` reply. A failed probe gives `error` 0 `other-error`.
export const WslIndexResult = z.union([WslIndexDigest, WslFileError]).meta({ id: "WslIndexResult", title: "WslIndexResult" });
export type WslIndexResult = z.infer<typeof WslIndexResult>;
const WslCopy = z.strictObject({ size: Count, sha256: Fingerprint, mtime: Stamp }).meta({ id: "WslCopy", title: "WslCopy" });
export const WslFileResult = z.union([
  z
    .strictObject({ kind: z.literal("file"), size: Count, changed: z.boolean(), sha256: Fingerprint.optional(), bound: z.enum(["COMPARED_RAW_VERSION_BYTES", "WHOLE_FILE_STAGE_INPUT_BYTES"]).optional() })
    .refine((r) => (r.sha256 === undefined) !== (r.bound === undefined))
    .meta({ title: "WslFileFile" }),
  z.strictObject({ kind: z.literal("directory") }).meta({ title: "WslFileDirectory" }),
  // Only a final link holds `targetBytes` and its `sha256`.
  z
    .strictObject({ kind: z.literal("link"), component: Count, targetBytes: TargetBytes.optional(), sha256: Fingerprint.optional() })
    .refine((r) => (r.targetBytes === undefined) === (r.sha256 === undefined))
    .meta({ title: "WslFileLink" }),
  z.strictObject({ kind: z.literal("absent") }).meta({ title: "WslFileAbsent" }),
  z.strictObject({ kind: z.literal("other") }).meta({ title: "WslFileOther" }),
  WslFileError,
  z.strictObject({ kind: z.literal("object"), size: Count, sha256: Fingerprint, oid: ObjectId.optional(), gitExit: WslExit, hashExit: WslExit }).meta({ title: "WslFileObject" }),
  z.strictObject({ kind: z.literal("blob"), size: Count, sha256: Fingerprint, over: z.boolean(), gitExit: WslExit, hashExit: WslExit }).meta({ title: "WslFileBlob" }),
  WslIndexDigest,
  z.strictObject({ kind: z.literal("lock"), device: Decimal, inode: Decimal }).meta({ title: "WslFileLock" }),
  z.strictObject({ kind: z.literal("locked") }).meta({ title: "WslFileLocked" }),
  z.strictObject({ kind: z.literal("candidate"), index: WslCopy, candidate: WslCopy }).meta({ title: "WslFileCandidate" }),
  // `candidate` above `MUTATION_RAW_INDEX_BYTES`.
  z.strictObject({ kind: z.literal("bound") }).meta({ title: "WslFileBound" }),
  z.strictObject({ kind: z.literal("published"), size: Count, sha256: Fingerprint }).meta({ title: "WslFilePublished" }),
  z.strictObject({ kind: z.literal("mismatch") }).meta({ title: "WslFileMismatch" }),
  z.strictObject({ kind: z.literal("notOwned") }).meta({ title: "WslFileNotOwned" }),
  z.strictObject({ kind: z.literal("removed") }).meta({ title: "WslFileRemoved" }),
]);
export type WslFileResult = z.infer<typeof WslFileResult>;
export const WslFilesReply = z.union([
  z.strictObject({ type: z.literal("wslFiles"), ...call, results: z.array(WslFileResult).min(1).max(FILE_FACT_ENTRIES) }).meta({ title: "WslFilesResults" }),
  z.strictObject({ type: z.literal("wslFiles"), ...walkDeadline }).meta({ title: "WslFilesDeadline" }),
]);

export const FileFactsReply = z.union([
  z
    .strictObject({ type: z.literal("fileFacts"), ...call, facts: z.array(FileFact).min(1).max(FILE_FACT_ENTRIES), index: WslIndexResult.optional() })
    .meta({ title: "FileFactsReply" }),
  z.strictObject({ type: z.literal("fileFacts"), ...walkDeadline }).meta({ title: "FileFactsDeadline" }),
]);
// ---- Feature 003 contract Δ6 replies ----

// A link or a junction gives `other`.
const destinationResult = { type: z.literal("destinationFacts"), ...call, result: z.enum(["absent", "empty", "not-empty", "file", "other"]) };
const destinationError = { type: z.literal("destinationFacts"), ...call, result: z.literal("error"), code: z.enum(FILE_FACT_ERRORS) };
// Feature 004 contract Δ6: the reply to the `worktreeAdd` form also carries the bound path in Git's form for the route.
// That is the Windows path for a Windows Git and the Linux path for a WSL Git. The `worktree add` path item must equal it byte for byte.
const gitPath = { path: Text.min(1) };
export const DestinationFactsReply = z.union([
  z.strictObject(destinationResult).meta({ title: "DestinationFactsResult" }),
  z.strictObject(destinationError).meta({ title: "DestinationFactsError" }),
  z.strictObject({ ...destinationResult, ...gitPath }).meta({ title: "DestinationFactsWorktreeAddResult" }),
  z.strictObject({ ...destinationError, ...gitPath }).meta({ title: "DestinationFactsWorktreeAddError" }),
]);
// Contract Δ9 `PUTTY_UNAVAILABLE`: the reason, the program, and its path.
const puttyFailed = { result: z.literal("failed"), reason: z.enum(PUTTY_UNAVAILABLE_REASONS), program: z.enum(PUTTY_PROGRAMS), path: ChannelPath };
export const PageantReply = z.union([
  // `git`: `sshClient` is `git`, so the shell starts no process.
  z.strictObject({ type: z.literal("pageant"), ...call, result: z.enum(["git", "none", "ready"]) }).meta({ title: "PageantResult" }),
  z.strictObject({ type: z.literal("pageant"), ...call, ...puttyFailed }).meta({ title: "PageantFailed" }),
]);
export const TerminalReply = z.union([
  z.strictObject({ type: z.literal("terminal"), ...call, result: z.literal("started") }).meta({ title: "TerminalStarted" }),
  z.strictObject({ type: z.literal("terminal"), ...call, ...puttyFailed }).meta({ title: "TerminalFailed" }),
]);
// ---- Feature 004 contract Δ6 replies ----

// `refused` names a reparse point or a non-regular file. `stale` names a size or SHA-256 other than `expected`.
// Every request gets one reply, also after `cancel` or `closeJob`. `stopped`: the stop came before the write, so nothing was written.
// `interrupted`: the stop came while a WSL `append` process could write, so the shell does not know whether it wrote.
export const FileAppendReply = z.union([
  z.strictObject({ type: z.literal("fileAppend"), ...call, result: z.enum(["appended", "stale", "stopped", "interrupted"]) }).meta({ title: "FileAppendResult" }),
  z.strictObject({ type: z.literal("fileAppend"), ...call, result: z.literal("refused"), reason: z.enum(["not-regular"]) }).meta({ title: "FileAppendRefused" }),
  z.strictObject({ type: z.literal("fileAppend"), ...call, result: z.literal("error"), code: z.enum(FILE_FACT_ERRORS) }).meta({ title: "FileAppendError" }),
]);
// An error gives the `refused` frame with `UNKNOWN_TARGET` (contract Δ3 `revealPath`).
export const RevealReply = z.strictObject({ type: z.literal("reveal"), ...call }).meta({ title: "RevealReply" });

export const ProcessReply = z.xor([
  OutputReply,
  ActivityReply,
  InputWrittenReply,
  ExitReply,
  Refused,
  IdentityListReply.meta({ title: "IdentityGroup" }),
  LingeringCountReply.meta({ title: "LingeringCountGroup" }),
  RegisterReply.meta({ title: "RegisterGroup" }),
  ResolveGitReply.meta({ title: "ResolveGitGroup" }),
  FileFactsReply.meta({ title: "FileFactsGroup" }),
  WslDistrosReply.meta({ title: "WslDistrosGroup" }),
  WslFilesReply.meta({ title: "WslFilesReplyGroup" }),
  DestinationFactsReply.meta({ title: "DestinationFactsGroup" }),
  PageantReply.meta({ title: "PageantReplyGroup" }),
  TerminalReply.meta({ title: "TerminalGroup" }),
  FileAppendReply.meta({ title: "FileAppendGroup" }),
  RevealReply,
]);

// ---- `mutation` frames (contract §6 "Recovery markers") ----

// Feature 003 contract Δ3 `reviewSync`: the nine actions.
export const SYNC_ACTIONS = ["fetch", "fetch-all", "pull", "integrate", "push", "force-push", "abort", "continue", "skip"] as const;
export const SyncAction = z.enum(SYNC_ACTIONS);
// Feature 004 contract Δ3 `reviewWorkbench`: the thirteen actions.
export const WORKBENCH_ACTIONS = [
  "switch",
  "create-branch",
  "rename-branch",
  "delete-branch",
  "merge",
  "rebase",
  "choose-side",
  "mergetool",
  "ignore",
  "worktree-add",
  "worktree-remove",
  "worktree-prune",
  "config-save",
] as const;
// Feature 004 contract Δ6: the action of a `started` frame of kind `workbench`. The close prompt names the side and the ignore target, so the action holds them.
export const WORKBENCH_STARTED_ACTIONS = [
  "switch",
  "create-branch",
  "rename-branch",
  "delete-branch",
  "merge",
  "rebase",
  "choose-ours",
  "choose-theirs",
  "mergetool",
  "ignore-gitignore",
  "ignore-exclude",
  "worktree-add",
  "worktree-remove",
  "worktree-prune",
  "config-save",
] as const;

const startedFields = {
  operationId: Identifier,
  repositoryId: Identifier,
  kind: MutationKind,
  direction: FileDirection.optional(),
  action: z.enum([...SYNC_ACTIONS, ...WORKBENCH_STARTED_ACTIONS]).optional(),
  worktreeRoot: ChannelPath,
  commonDirectory: ChannelPath,
};
const DIRECTED: readonly string[] = ["applyHunk", "applyFile", "applyFiles"];
const SYNC: readonly string[] = SYNC_ACTIONS;
const WORKBENCH: readonly string[] = WORKBENCH_STARTED_ACTIONS;
// Contract §6 "Mutation frames": a hunk or file action carries its direction, and no other kind carries one.
// Feature 003 contract Δ3: only a file action takes `resolve`. Contract Δ6: a `sync` frame carries its action, and no other kind carries one.
// Feature 004 contract Δ6: a `workbench` frame carries its action, and an `applyFiles` frame carries `stage` or `unstage`.
const directionRule = (frame: { kind: string; direction?: string; action?: string }) =>
  DIRECTED.includes(frame.kind) === (frame.direction !== undefined) &&
  (frame.kind === "applyFile" || !DIRECTED.includes(frame.kind) || Direction.safeParse(frame.direction).success) &&
  (frame.kind === "sync" ? SYNC.includes(frame.action ?? "") : frame.kind === "workbench" ? WORKBENCH.includes(frame.action ?? "") : frame.action === undefined);
export const StartedCall = z.strictObject(startedFields).refine(directionRule);
export type MutationStarted = z.infer<typeof StartedCall>;

export const MutationRequest = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), ...call, ...startedFields }).refine(directionRule).meta({ title: "Started" }),
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
export const MutationReply = z.xor([StartedReply.meta({ title: "StartedGroup" }), Refused]);

// ---- `trust` frames (contract §7 "Trust approval store", feature 004 contract Δ6) ----

// Contract Δ6: the action that the dialog names. `repository` names no Git action: the status bar chip sends it (plan D12).
export const TRUST_ACTIONS = ["commit", "read", "fetch", "pull", "push", "switch", "branch", "merge", "rebase", "resolve", "mergetool", "worktree", "submodules", "repository"] as const;
export type TrustAction = (typeof TRUST_ACTIONS)[number];
// Contract Δ5 "Trust dialog names per kind". It is no output bound, so `limits.ts` does not list it.
export const TRUST_DIALOG_NAMES = 20;
// Plan D14: the service and the shell show an empty name, or a name with a character of the categories Cc, Cf, Zl, or Zp, as a fixed text.
// So the frame admits any text without NUL.
const dialogNames = <T extends z.ZodType>(item: T) => z.strictObject({ names: z.array(item).max(TRUST_DIALOG_NAMES), more: Count });
// Contract Δ6 `details` and data-model §10 `programs`: the repository-controlled programs by name and scope, never a value.
// A hooks-folder hook names its folder. A `hook.<name>.event` hook names the scope of its command.
// `other` names each other program key and the keys `core.hooksPath` and `protocol.allow`. Contract Δ6 lists no kind for them.
export const TrustDetails = z
  .strictObject({
    hooks: dialogNames(
      z.union([z.strictObject({ event: Text, folder: Text }).meta({ title: "FolderHookName" }), z.strictObject({ event: Text, scope: ConfigScope }).meta({ title: "ConfiguredHookName" })]),
    ),
    filters: dialogNames(z.strictObject({ driver: Text, scope: ConfigScope })),
    monitors: dialogNames(z.strictObject({ scope: ConfigScope })),
    mergeDrivers: dialogNames(z.strictObject({ driver: Text, scope: ConfigScope })),
    mergeTools: dialogNames(z.strictObject({ tool: Text, scope: ConfigScope })),
    signing: dialogNames(z.strictObject({ key: Text, scope: ConfigScope })),
    other: dialogNames(z.strictObject({ key: Text, scope: ConfigScope })),
  })
  .meta({ title: "TrustDetails" });
export type TrustDetails = z.infer<typeof TrustDetails>;

// Contract Δ6 `confirm` version 2: no fingerprint, `persist`, or `bound`.
const confirm = {
  type: z.literal("confirm"),
  worktreeRoot: ChannelPath,
  adminDirectory: ChannelPath,
  commonDirectory: ChannelPath,
  gitSelectedPath: ChannelPath,
  policyVersion: z.literal(2),
  action: z.enum(TRUST_ACTIONS),
  details: TrustDetails,
};
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
  z.strictObject(confirm).meta({ title: "ConfirmCall" }),
  z.strictObject(revoke).meta({ title: "RevokeCall" }),
  z.strictObject(confirmRun).refine(countRule).meta({ title: "ConfirmRunCall" }),
]);
export type TrustRequest = z.infer<typeof TrustCall>;

export const TrustRequest = z.discriminatedUnion("type", [
  z.strictObject({ ...confirm, ...call }).meta({ title: "Confirm" }),
  z.strictObject({ ...revoke, ...call }).meta({ title: "Revoke" }),
  z.strictObject({ ...confirmRun, ...call }).refine(countRule).meta({ title: "ConfirmRun" }),
]);

const reply = (type: "confirm" | "confirmRun" | "revoke") => ({ type: z.literal(type), ...call });
// Contract Δ6: a stored approval replies with the version 2 record.
export const ConfirmReply = z.union([
  z.strictObject({ ...reply("confirm"), result: z.literal("declined") }).meta({ title: "ConfirmDeclined" }),
  z.strictObject({ ...reply("confirm"), result: z.literal("approved"), stored: z.literal(false) }).meta({ title: "ConfirmSession" }),
  z.strictObject({ ...reply("confirm"), result: z.literal("approved"), stored: z.literal(true), record: TrustRecordV2 }).meta({ title: "ConfirmStored" }),
]);
export const ConfirmRunReply = z.strictObject({ ...reply("confirmRun"), result: z.enum(["approved", "declined"]) }).meta({ title: "ConfirmRunReply" });
export const RevokeReply = z.union([
  z.strictObject({ ...reply("revoke"), endedProcesses: Count }).meta({ title: "RevokeReply" }),
  z.strictObject({ type: z.literal("revoke"), ...walkDeadline }).meta({ title: "RevokeDeadline" }),
]);
export const TrustReply = z.xor([ConfirmReply.meta({ title: "ConfirmGroup" }), ConfirmRunReply, RevokeReply.meta({ title: "RevokeGroup" }), Refused]);
