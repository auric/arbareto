// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { FileIdentity, ProcessContext } from "../contracts/channel";
import type { RegistrationResult } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { REGISTERED_WORKSPACES } from "../contracts/limits";
import { DISCOVERY_REMEDIES, discoverRepository, type DiscoveredRepository, type DiscoveryRefusal } from "./discovery";
import type { GitInstallation } from "./git-installation";
import { RunnerRefusal, type GitRunner } from "./git-runner";
import { IDENTITY_REMEDY, requestIdentities, sameIdentity } from "./identity";

// Data-model §2: one registered workspace of this service session.
export interface Workspace extends DiscoveredRepository {
  repositoryId: string;
  gitInstallationId: string;
  // The identities of `worktreeRoot` and `gitDirectory`, in that order.
  worktreeIdentity: [FileIdentity, FileIdentity];
  commonIdentity: FileIdentity;
  worktreeKey: string;
  generation: number;
}

export interface RegistrationTarget {
  operationId: string;
  bootstrapId: string;
  installation: GitInstallation;
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
export function worktreeKey(identity: FileIdentity): string {
  return new Bun.CryptoHasher("sha256").update(Buffer.from(identity.volumeSerial + identity.fileId, "hex")).digest("hex");
}

const registered = (w: Workspace): RegistrationOutcome => ({ ok: true, result: { repositoryId: w.repositoryId, generation: w.generation, worktreeKey: w.worktreeKey } });

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
  async function commit(target: RegistrationTarget, repository: DiscoveredRepository, identities: FileIdentity[]): Promise<RegistrationOutcome> {
    if (target.signal.aborted) return canceled;
    const [rootIdentity, gitIdentity, commonIdentity] = identities as [FileIdentity, FileIdentity, FileIdentity];
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
