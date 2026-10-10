// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ProcessContext } from "../contracts/channel";
import type { RegistrationResult } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { REGISTERED_WORKSPACES } from "../contracts/limits";
import { routeWslPath } from "../contracts/wsl-route";
import { DISCOVERY_REMEDIES, discoverRepository, isMergedRefusal, type DiscoveredRepository, type DiscoveryRefusal } from "./discovery";
import type { GitInstallation } from "./git-installation";
import { RunnerRefusal, type GitRunner, type WslRunner } from "./git-runner";
import { IDENTITY_REMEDY, requestIdentities, requestWslIdentities, sameIdentity, type PhysicalIdentity } from "./identity";
import { checkWslProbe, gitChanged, routeRegistration, runWslProbe, type WslGit, type WslProbeTarget } from "./wsl";

// Data-model §2: one registered workspace of this service session.
export interface Workspace extends DiscoveredRepository {
  repositoryId: string;
  gitInstallationId: string;
  // The identities of `worktreeRoot` and `gitDirectory`, in that order.
  worktreeIdentity: [PhysicalIdentity, PhysicalIdentity];
  commonIdentity: PhysicalIdentity;
  worktreeKey: string;
  generation: number;
  // Contract §11: the WSL Git of a WSL workspace. Its paths above are the UNC identity paths.
  wsl?: WslGit;
}

export interface RegistrationTarget {
  operationId: string;
  bootstrapId: string;
  installation: Pick<GitInstallation, "gitInstallationId" | "selectedPath">;
  signal: AbortSignal;
}

export type RegistrationOutcome = { ok: true; result: RegistrationResult } | { ok: false; code: ErrorCode; result?: RegistrationResult };

export interface RegistrationOptions {
  runner: GitRunner;
  // Contract §6 "Registration reuse and release": true while a mutation of that workspace is `running`, `cancel-requested`, or `reconciling`.
  unfinishedMutation(repositoryId: string): boolean;
  // Data-model §4 "Status snapshot retention": a workspace release releases its retained state.
  onRelease?(workspace: Workspace): void;
  // A new workspace. A reused workspace gives no call.
  onRegister?(workspace: Workspace): void;
}

const refused = (value: DiscoveryRefusal): RegistrationOutcome => {
  const { code, ...result } = value;
  return { ok: false, code, ...(Object.keys(result).length === 0 ? {} : { result }) };
};

const unavailable: RegistrationOutcome = { ok: false, code: "REPOSITORY_UNAVAILABLE", result: { remedy: { text: DISCOVERY_REMEDIES.unavailable } } };
// Contract §6 "Channel frames": a `refused` reply started nothing and keeps its own code.
const runnerRefused = (error: unknown): RegistrationOutcome => {
  if (!(error instanceof RunnerRefusal)) throw error;
  return { ok: false, code: error.code };
};

// Contract §6 "Registration bootstrap": a failed identity refuses registration.
const identityRefused: RegistrationOutcome = { ok: false, code: "UNSUPPORTED_REPOSITORY", result: { remedy: { text: IDENTITY_REMEDY } } };
const canceled: RegistrationOutcome = { ok: false, code: "CANCELED" };
// Contract §5 "Deadline outcomes": a walk deadline of a registration gives DEADLINE.
const deadline: RegistrationOutcome = { ok: false, code: "DEADLINE" };

// Contract §3 "Worktree key": the SHA-256 of the 8 volume serial bytes and the 16 file ID bytes, in the hex order of the identity reply.
// A WSL worktree: the SHA-256 of the UTF-8 text `<distroGuid>:<fileSystemId>:<inode>`, each field as the identity reply holds it.
export function worktreeKey(identity: PhysicalIdentity): string {
  const hasher = new Bun.CryptoHasher("sha256");
  if ("distroGuid" in identity) return hasher.update(`${identity.distroGuid}:${identity.fileSystemId}:${identity.inode}`).digest("hex");
  return hasher.update(Buffer.from(identity.volumeSerial + identity.fileId, "hex")).digest("hex");
}

const registered = (w: Workspace): RegistrationOutcome => ({ ok: true, result: { repositoryId: w.repositoryId, generation: w.generation, worktreeKey: w.worktreeKey } });

// Contract §6 "Dismissal": an allowed dismissal goes on to the native confirmation.
export type DismissalOutcome = { ok: true } | { ok: false; code: ErrorCode; result?: { remedy: { text: string } } };
const dismissalRefused: DismissalOutcome = { ok: false, code: "STATE_UNKNOWN", result: { remedy: { text: DISCOVERY_REMEDIES.dismissalRefused } } };

// Contract §6 "Dismissal", WSL marker rule and decision W13. Allowed when `wslDistros` does not list the distro of the path,
// when the §11 probe reports the path `absent`, when discovery call 1 gives the merged refusal, or when the common-directory identity differs from the marker.
// A dismissal shows no Git confirmation, so discovery runs only with the approved session Git of the distro, unchanged since its probe.
export async function dismissWslMarker(
  runner: GitRunner & WslRunner,
  target: WslProbeTarget,
  marker: { commonIdentity: PhysicalIdentity },
  session: WslGit | undefined,
): Promise<DismissalOutcome> {
  const { operationId, bootstrapId, signal } = target;
  const stopped = (code: ErrorCode): DismissalOutcome => (code === "DEADLINE" || code === "CANCELED" ? { ok: false, code } : dismissalRefused);
  try {
    const reply = await runner.wslDistros({ operationId, bootstrapId });
    if ("listed" in reply) {
      // Contract §11 "Route": a match that ignores ASCII letter case also names a listed distro.
      // ECMA-262 Canonicalize without the `u` flag never folds a non-ASCII character to ASCII.
      const path = routeWslPath(reply.path, { listed: reply.listed, registry: reply.keys });
      const segment = path.kind === "refused" && path.reason === "distro-missing" ? new RegExp(`^${RegExp.escape(path.distro)}$`, "i") : null;
      if (segment !== null && !reply.listed.some((name) => segment.test(name))) return { ok: true };
    }
    const route = routeRegistration(reply);
    if ("ok" in route || route.kind === "windows") return dismissalRefused;
    const probe = await runWslProbe(runner, route, target);
    if (!probe.ok) return "canceled" in probe ? { ok: false, code: "CANCELED" } : stopped(probe.code);
    // Contract §11 "Git per distro": the program checks come first, so `absent` counts only when the path rule refuses.
    const checked = checkWslProbe(route.distro, probe.facts, route.wslExecutable);
    if (!checked.ok) return checked.code === "UNSUPPORTED_REPOSITORY" && probe.facts.facts.selstat === "absent" ? { ok: true } : dismissalRefused;
    if (session === undefined || session.guid !== route.guid || session.path !== checked.git.path || gitChanged(session, checked.git)) return dismissalRefused;
    const { gitInstallationId } = session;
    const discovered = await discoverRepository(runner, { operationId, bootstrapId, gitInstallationId, gitSelectedPath: session.path, signal, wsl: { distro: route.distro } });
    if (!discovered.ok) return isMergedRefusal(discovered.refusal) ? { ok: true } : stopped(discovered.refusal.code);
    const context: ProcessContext = { contextKind: "repositoryDiscovery", bootstrapId, gitInstallationId };
    const found = await requestWslIdentities(runner, operationId, context, [discovered.repository.commonDirectory], session, signal);
    if (!found.ok) return "stop" in found ? stopped(found.stop === "deadline" ? "DEADLINE" : "CANCELED") : dismissalRefused;
    return sameIdentity(found.identities[0]!, marker.commonIdentity) ? dismissalRefused : { ok: true };
  } catch (error) {
    if (error instanceof RunnerRefusal) return { ok: false, code: error.code };
    if (signal.aborted) return { ok: false, code: "CANCELED" };
    throw error;
  }
}

export function createRegistrations({ runner, unfinishedMutation, onRelease, onRegister }: RegistrationOptions) {
  const workspaces = new Map<string, Workspace>();
  // The reuse, limit, and release decision and the `register` frame run one registration at a time.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const next = tail.then(body);
    tail = next.catch(() => {});
    return next;
  };

  const release = (w: Workspace) => {
    workspaces.delete(w.repositoryId);
    runner.release({ repositoryId: w.repositoryId });
    onRelease?.(w);
  };

  // Contract §6 "Registration reuse and release". The caller holds `exclusive`.
  // A registered workspace matches only with the same worktree identity and the same `gitInstallationId`.
  async function commit(target: RegistrationTarget, repository: DiscoveredRepository, identities: PhysicalIdentity[], wsl?: WslGit): Promise<RegistrationOutcome> {
    if (target.signal.aborted) return canceled;
    const [rootIdentity, gitIdentity, commonIdentity] = identities as [PhysicalIdentity, PhysicalIdentity, PhysicalIdentity];
    const all = [...workspaces.values()];
    const same = all.find(
      (w) => w.gitInstallationId === target.installation.gitInstallationId && sameIdentity(w.worktreeIdentity[0], rootIdentity) && sameIdentity(w.worktreeIdentity[1], gitIdentity),
    );
    if (same) return registered(same);
    const released = all.filter((w) => !sameIdentity(w.commonIdentity, commonIdentity));
    if (released.some((w) => unfinishedMutation(w.repositoryId))) return { ok: false, code: "BUSY" };
    if (all.length - released.length >= REGISTERED_WORKSPACES) return { ok: false, code: "WORKSPACE_LIMIT", result: { limit: REGISTERED_WORKSPACES } };

    const repositoryId = crypto.randomUUID();
    const { gitInstallationId } = target.installation;
    const { worktreeRoot, gitDirectory, commonDirectory } = repository;
    let reply;
    try {
      reply = await runner.register({ operationId: target.operationId, bootstrapId: target.bootstrapId, gitInstallationId, repositoryId, worktreeRoot, gitDirectory, commonDirectory });
    } catch (error) {
      return runnerRefused(error);
    }
    if ("stop" in reply) return deadline;
    if (reply.result !== "approved") return unavailable;
    // Contract §3 `chooseRepository`: Cancel preserves the current workspace.
    if (target.signal.aborted) {
      runner.release({ repositoryId });
      return canceled;
    }
    for (const w of released) release(w);
    const workspace: Workspace = {
      ...repository,
      repositoryId,
      gitInstallationId,
      worktreeIdentity: [rootIdentity, gitIdentity],
      commonIdentity,
      worktreeKey: worktreeKey(rootIdentity),
      generation: 0,
      ...(wsl ? { wsl } : {}),
    };
    workspaces.set(repositoryId, workspace);
    onRegister?.(workspace);
    return registered(workspace);
  }

  return {
    // Contract §3 `chooseRepository` and `restoreWorkspace`: discovery and identities in the bootstrap context, then the `repositoryId`.
    async register(target: RegistrationTarget): Promise<RegistrationOutcome> {
      const { operationId, bootstrapId, installation, signal } = target;
      const context: ProcessContext = { contextKind: "repositoryDiscovery", bootstrapId, gitInstallationId: installation.gitInstallationId };
      let discovered;
      try {
        discovered = await discoverRepository(runner, { operationId, bootstrapId, gitInstallationId: installation.gitInstallationId, gitSelectedPath: installation.selectedPath, signal });
      } catch (error) {
        return runnerRefused(error);
      }
      if (!discovered.ok) return refused(discovered.refusal);
      const { worktreeRoot, gitDirectory, commonDirectory } = discovered.repository;
      let identities;
      try {
        identities = await requestIdentities(runner, operationId, context, [worktreeRoot, gitDirectory, commonDirectory], signal);
      } catch (error) {
        return runnerRefused(error);
      }
      if (!identities.ok) return "stop" in identities ? (identities.stop === "deadline" ? deadline : canceled) : identityRefused;
      return exclusive(() => commit(target, discovered.repository, identities.identities));
    },
    // Contract §11: a WSL registration with the WSL Git of the route distro.
    // gaps.md W1: the probe bound the selected folder identity, so the first request here is discovery.
    async registerWsl(target: Omit<RegistrationTarget, "installation">, git: WslGit): Promise<RegistrationOutcome> {
      const { operationId, bootstrapId, signal } = target;
      const { gitInstallationId } = git;
      const context: ProcessContext = { contextKind: "repositoryDiscovery", bootstrapId, gitInstallationId };
      try {
        const discovered = await discoverRepository(runner, { operationId, bootstrapId, gitInstallationId, gitSelectedPath: git.path, signal, wsl: { distro: git.distro } });
        if (!discovered.ok) return refused(discovered.refusal);
        const { worktreeRoot, gitDirectory, commonDirectory } = discovered.repository;
        const found = await requestWslIdentities(runner, operationId, context, [worktreeRoot, gitDirectory, commonDirectory], git, signal);
        if (!found.ok) return "stop" in found ? (found.stop === "deadline" ? deadline : canceled) : found;
        const installation = { gitInstallationId, selectedPath: git.path };
        return exclusive(() => commit({ ...target, installation }, discovered.repository, found.identities, git));
      } catch (error) {
        return runnerRefused(error);
      }
    },
    has: (repositoryId: string): boolean => workspaces.has(repositoryId),
    get: (repositoryId: string): Workspace | undefined => workspaces.get(repositoryId),
    // Contract §3 `chooseGit`: a new installation releases every workspace of the previous one, then the installation itself.
    // It holds the registration lock, so a registration in flight commits first or meets the released installation.
    // `busy`: a workspace has an unfinished mutation, and nothing changes. `stopped`: `proceed` gave false inside the lock, and nothing changes.
    releaseInstallation(gitInstallationId: string, proceed: () => boolean): Promise<"released" | "busy" | "stopped"> {
      return exclusive(async () => {
        if (!proceed()) return "stopped";
        const bound = [...workspaces.values()].filter((w) => w.gitInstallationId === gitInstallationId);
        if (bound.some((w) => unfinishedMutation(w.repositoryId))) return "busy";
        for (const w of bound) release(w);
        runner.release({ gitInstallationId });
        return "released";
      });
    },
  };
}

export type Registrations = ReturnType<typeof createRegistrations>;
