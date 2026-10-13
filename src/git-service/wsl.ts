// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §11 "WSL repositories": the route of a registration, the Git probe rules, and the WSL Git of each distro.

import { WslIdentity } from "../contracts/channel";
import type { RegistrationResult } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { BOOTSTRAP_DEADLINE_CAP_MS, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, WSL_DISTRO_START_MS } from "../contracts/limits";
import { buildSubmoduleOutputTail } from "../contracts/submodules";
import { buildWslRemedy, checkWslGit, isWindowsProgram, routeWslPath, WSL_MINIMUM_GIT_VERSION } from "../contracts/wsl-route";
import { createCollector, type GitRunner, type WslDistrosResult, type WslRunner } from "./git-runner";

// The approved Linux Git of one distro in this service session (data-model §1).
export interface WslGit {
  gitInstallationId: string;
  distro: string;
  guid: string;
  // The absolute Linux path of the Git file.
  path: string;
  version: string;
  // `<file-system ID>:<inode>:<size>:<modification time>` of the Git file.
  identity: string;
  // The `PATH` of the probe, for the contract §11 bare-name rule.
  pathEnv: string;
  // Contract §11 "Remedy commands": `<System32 path>\wsl.exe` from the shell's `wslDistros` reply.
  wslExecutable: string;
  // Contract §11 "Process launch": the approved helper paths of the wrapper. The shell binds the same probe values.
  systemdRun: string;
  systemctl: string;
  setsid: string;
  // The probe fact `noexpand 0`: `systemd-run` takes `--expand-environment=no`, so the wrapper gets `noexp` 1.
  noexpand: boolean;
}

export type WslRefusal = { ok: false; code: ErrorCode; result?: RegistrationResult };

// Contract §9 and §11 texts.
const TEXT = {
  "wsl-missing": () => "WSL is not available on this computer. Install WSL2, then open the folder again.",
  "distro-missing": (name: string) => `No registered WSL distro has the name ${name}. Open the folder through a listed distro.`,
  "not-wsl2": (name: string) => `Distro ${name} is not a WSL2 distro. Arbareto opens repositories only in WSL2 distros.`,
  "no-user-manager": () =>
    "Arbareto needs the systemd user manager in this distro to end the processes that Git starts. Set systemd=true under [boot] in /etc/wsl.conf, then restart the distro.",
  "scope-arguments": (name: string) => `systemd-run in ${name} does not pass Git arguments unchanged. Update systemd in the distro to version 254 or later.`,
  "no-setsid": (name: string) => `Arbareto needs the setsid program in ${name}. Install the util-linux package in the distro, then open the folder again.`,
  "no-coreutils": (name: string) => `Arbareto needs the stat, env, and sha256sum programs in /usr/bin of ${name}. Install the coreutils package in the distro, then open the folder again.`,
  "start-failed": (name: string) => `WSL could not start distro ${name}. Start it in a terminal, then open the folder again.`,
  "windows-git": (name: string) => `The git command in ${name} is Git for Windows. Install Linux Git 2.55.0 or later in the distro.`,
  "git-no-fs-uuid": (name: string) => `Arbareto cannot read a file-system UUID for Git in ${name}. Install Git on the distro's own disk.`,
  "git-missing": (name: string) => `Install Git 2.55.0 or later in ${name}.`,
  "wsl-path": () => "This path holds a name that Windows cannot show. Open another folder.",
  "mixed-location": () => "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows.",
  "no-fs-uuid": () => "Arbareto cannot read a file-system UUID for this folder. Open a folder on the distro's own disk.",
  "no-perl": (name: string) => `Arbareto needs Perl in ${name} to check hook and program files. Install the distro's perl package, then open the repository again.`,
  identity: (name: string) => `Arbareto cannot read the identity of this folder in ${name}. Check that the folder exists on the distro's own disk.`,
  "git-path": (name: string, git: string) => `The Git path ${git} in ${name} holds a name that Windows cannot show. Install Git in another folder of the distro, then approve again.`,
} as const;

// T212 decision W8: the remedy of an `approveTrust` whose WSL Git path has no UNC form.
export const gitPathText = (git: Pick<WslGit, "distro" | "path">): string => TEXT["git-path"](git.distro, git.path);

// A WSL identity that the shell cannot read, for the selected folder or a Git-resolved directory.
export const identityRefusal = (distro: string): WslRefusal => ({ ok: false, code: "UNSUPPORTED_REPOSITORY", result: { text: TEXT.identity(distro) } });

const PPA_TEXT = "This command adds the official git-core PPA and installs its Git.";

// Contract §9: the `UNSUPPORTED_REPOSITORY` results of the §11 path rules.
export const PATH_RESULTS = {
  "wsl-path": { reason: "wsl-path", text: TEXT["wsl-path"]() },
  "mixed-location": { reason: "mixed-location", text: TEXT["mixed-location"]() },
  "no-fs-uuid": { reason: "no-fs-uuid", text: TEXT["no-fs-uuid"]() },
} as const;
export const WSL_PATH_REFUSAL: WslRefusal = { ok: false, code: "UNSUPPORTED_REPOSITORY", result: PATH_RESULTS["wsl-path"] };
export const MIXED_LOCATION_REFUSAL: WslRefusal = { ok: false, code: "UNSUPPORTED_REPOSITORY", result: PATH_RESULTS["mixed-location"] };
export const NO_FS_UUID_REFUSAL: WslRefusal = { ok: false, code: "UNSUPPORTED_REPOSITORY", result: PATH_RESULTS["no-fs-uuid"] };

const unavailable = (reason: keyof typeof TEXT & ("wsl-missing" | "distro-missing" | "not-wsl2" | "no-user-manager" | "scope-arguments" | "no-setsid" | "no-coreutils" | "no-perl"), name: string): WslRefusal => ({
  ok: false,
  code: "WSL_UNAVAILABLE",
  result: { reason, text: TEXT[reason](name) },
});

// ---- The probe output (src/contracts/wsl-process.json `probe`) ----

const PROBED = ["git", "systemd-run", "systemctl", "setsid", "stat", "env", "perl", "sha256sum"] as const;
type Probed = (typeof PROBED)[number];
const FACTS = ["pathenv", "osid", "version", "gitfs", "gitfile", "scope", "selfs", "selino", "selstat", "noexpand", "verbatim"] as const;
type Fact = (typeof FACTS)[number];

export interface WslProbeFacts {
  programs: Partial<Record<Probed, { path: string; mz: boolean }>>;
  facts: Partial<Record<Fact, string>>;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isProbed = (name: string): name is Probed => (PROBED as readonly string[]).includes(name);
const isFact = (name: string): name is Fact => (FACTS as readonly string[]).includes(name);

// Strict UTF-8 lines (contract §11 "Distro checks"). Each line kind appears at most once, so a line end inside a value cannot replace a fact.
// The shell applies the same rule in `src-tauri/src/wsl.rs` `bind_probe`. `null`: the output breaks the line format.
export function parseWslProbe(bytes: Uint8Array): WslProbeFacts | null {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (!text.endsWith("\n")) return null;
  const seen = new Set<string>();
  const paths = new Map<Probed, string>();
  const magic = new Map<Probed, string>();
  const absent = new Set<Probed>();
  const facts: Partial<Record<Fact, string>> = {};
  for (const line of text.slice(0, -1).split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) return null;
    const kind = line.slice(0, space);
    const rest = line.slice(space + 1);
    let key: string;
    if (kind === "path" || kind === "magic") {
      const next = rest.indexOf(" ");
      const name = next < 0 ? "" : rest.slice(0, next);
      if (!isProbed(name)) return null;
      key = `${kind} ${name}`;
      (kind === "path" ? paths : magic).set(name, rest.slice(next + 1));
    } else if (kind === "absent") {
      if (!isProbed(rest)) return null;
      key = `absent ${rest}`;
      absent.add(rest);
    } else if (isFact(kind)) {
      key = kind;
      facts[kind] = rest;
    } else return null;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const programs: WslProbeFacts["programs"] = {};
  for (const name of PROBED) {
    const path = paths.get(name);
    const mark = magic.get(name);
    if (path === undefined && mark === undefined) continue;
    // A `path` line comes with its `magic` line, and the probe prints only absolute paths.
    if (path === undefined || !path.startsWith("/") || (mark !== "MZ" && mark !== "-") || absent.has(name)) return null;
    programs[name] = { path, mz: mark === "MZ" };
  }
  return { programs, facts };
}

// Contract §11 "Git per distro": Ubuntu means `ID=ubuntu`. os-release(5): the value can also stand in double or single quotes.
const isUbuntu = (osid: string | undefined) => osid === "ubuntu" || osid === '"ubuntu"' || osid === "'ubuntu'";

// A Linux program that the §11 rule admits: present, and neither under `/mnt/` nor a file that starts with `MZ`.
const native = (program: { path: string; mz: boolean } | undefined) => program !== undefined && !isWindowsProgram(program.path, program.mz);

// gaps.md W1 "Typed refusals": the rows of the context path. `src-tauri/src/wsl.rs` `classify` binds only a path that passes them.
// linux/magic.h: `ef53` is EXT4_SUPER_MAGIC, and `1021997` is V9FS_MAGIC, the 9P share of a Windows drive.
function checkPath(distro: string, facts: WslProbeFacts["facts"]): WslRefusal | null {
  const refused = identityRefusal(distro);
  if (facts.selstat !== "ok") return refused;
  const fs = /^([0-9a-f]+):([0-9a-f]+)$/.exec(facts.selfs ?? "");
  if (fs === null) return refused;
  if (fs[1] === "1021997") return MIXED_LOCATION_REFUSAL;
  if (fs[1] !== "ef53" || /^0+$/.test(fs[2]!)) return NO_FS_UUID_REFUSAL;
  const canonical = WslIdentity.shape.fileSystemId.safeParse(fs[2]).success && WslIdentity.shape.inode.safeParse(facts.selino).success;
  return canonical ? null : refused;
}

// Contract §11 "Git per distro". The order: the path programs, the context path, no Git, a Windows Git, the other helper programs, the version, then the Git file identity.
export function checkWslProbe(distro: string, probe: WslProbeFacts, wslExecutable: string): { ok: true; git: Omit<WslGit, "gitInstallationId" | "guid"> } | WslRefusal {
  const { programs, facts } = probe;
  if (!native(programs.stat) || !native(programs.env) || !native(programs.sha256sum)) return unavailable("no-coreutils", distro);
  if (!native(programs.perl)) return unavailable("no-perl", distro);
  const path = checkPath(distro, facts);
  if (path !== null) return path;
  const git = programs.git;
  if (git === undefined) return { ok: false, code: "GIT_UNAVAILABLE", result: { text: TEXT["git-missing"](distro) } };
  if (isWindowsProgram(git.path, git.mz)) return { ok: false, code: "GIT_UNSUPPORTED", result: { reason: "windows-git", text: TEXT["windows-git"](distro) } };
  if (!native(programs["systemd-run"]) || !native(programs.systemctl) || facts.scope !== "0") return unavailable("no-user-manager", distro);
  // T378: `noexpand` is the `$?` of `systemd-run --expand-environment=no --version`, a decimal from 0 to 255. Only `verbatim 0` proves unchanged scope arguments.
  const status = facts.noexpand ?? "";
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(status) || Number(status) > 255 || facts.verbatim !== "0") return unavailable("scope-arguments", distro);
  if (!native(programs.setsid)) return unavailable("no-setsid", distro);
  const checked = checkWslGit({ path: git.path, mz: git.mz, versionText: facts.version ?? "" });
  if (!checked.ok) {
    if (checked.reason === "windows-git") return { ok: false, code: "GIT_UNSUPPORTED", result: { reason: "windows-git", text: TEXT["windows-git"](distro) } };
    const found = checked.detectedVersion === undefined ? "" : ` ${checked.detectedVersion}`;
    let text = `Git${found} in ${distro} is older than ${WSL_MINIMUM_GIT_VERSION}. Install Git ${WSL_MINIMUM_GIT_VERSION} or later in the distro.`;
    const remedy = isUbuntu(facts.osid) ? buildWslRemedy("git-ppa", { wslExecutable, distro }).command : null;
    if (remedy !== null) text += ` ${PPA_TEXT}`;
    return {
      ok: false,
      code: "GIT_UNSUPPORTED",
      result: {
        reason: "version",
        ...(checked.detectedVersion === undefined ? {} : { detectedVersion: checked.detectedVersion }),
        minimumVersion: checked.minimumVersion,
        text,
        ...(remedy === null ? {} : { command: remedy }),
      },
    };
  }
  // Contract §11 "Paths and file access": only type `ef53` with a nonzero ID gives a stable file-system ID.
  const fileSystem = /^ef53:([0-9a-f]+)$/.exec(facts.gitfs ?? "")?.[1];
  const file = facts.gitfile ?? "";
  if (fileSystem === undefined || /^0+$/.test(fileSystem) || !/^[0-9]+:[0-9]+:[0-9]+$/.test(file)) {
    return { ok: false, code: "GIT_UNSUPPORTED", result: { reason: "no-fs-uuid", text: TEXT["git-no-fs-uuid"](distro) } };
  }
  return { ok: true, git: { distro, path: git.path, version: checked.version, identity: `${fileSystem}:${file}`, pathEnv: facts.pathenv ?? "", wslExecutable, systemdRun: programs["systemd-run"]!.path, systemctl: programs.systemctl!.path, setsid: programs.setsid!.path, noexpand: status === "0" } };
}

// ---- The route and the Git probe of one registration ----

export type WslRoute =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string; guid: string; running: boolean; saved?: { git: string; identity: string }; wslExecutable: string }
  | WslRefusal;

// Contract §11 "Route" and "Distro checks". The shell names the context path, because the service holds only the bootstrap ID.
export function routeRegistration(reply: WslDistrosResult): WslRoute {
  if ("code" in reply) return { ok: false, code: "WSL_UNAVAILABLE", result: { reason: "wsl-missing", text: TEXT["wsl-missing"]() } };
  if (!("listed" in reply)) return { kind: "windows" };
  const route = routeWslPath(reply.path, { listed: reply.listed, registry: reply.keys });
  if (route.kind === "windows") return route;
  if (route.kind === "refused") return route.code === "UNSUPPORTED_REPOSITORY" ? WSL_PATH_REFUSAL : unavailable(route.reason, route.distro);
  const saved = reply.saved.find((s) => s.guid === route.guid);
  return {
    kind: "wsl",
    distro: route.distro,
    guid: route.guid,
    running: reply.running.includes(route.distro),
    ...(saved ? { saved: { git: saved.git, identity: saved.gitIdentity } } : {}),
    wslExecutable: reply.wslExecutable,
  };
}

export interface WslProbeTarget {
  operationId: string;
  bootstrapId: string;
  signal: AbortSignal;
  // Contract §11 "Distro start": called with the listed distro name before the probe of a distro that the running list does not name.
  starting(distro: string): void;
}

// Contract §11 "Distro start": the probe run and its parsed lines. `canceled` means that the signal ended the probe.
export async function runWslProbe(
  runner: WslRunner,
  route: Extract<WslRoute, { kind: "wsl" }>,
  target: WslProbeTarget,
): Promise<{ ok: true; facts: WslProbeFacts } | WslRefusal | { ok: false; canceled: true }> {
  if (!route.running) target.starting(route.distro);
  const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  // Contract §5: the WSL distro start deadline for a stopped distro, the probe deadline otherwise.
  const deadlineMs = route.running ? BOOTSTRAP_DEADLINE_CAP_MS : WSL_DISTRO_START_MS;
  let exit;
  try {
    exit = await runner.wslProbe({ operationId: target.operationId, bootstrapId: target.bootstrapId, distro: route.distro, limits: { deadlineMs }, stdout, stderr, signal: target.signal });
  } catch (error) {
    if (target.signal.aborted) return { ok: false, canceled: true };
    throw error;
  }
  if (target.signal.aborted) return { ok: false, canceled: true };
  if (exit.deadline) return { ok: false, code: "DEADLINE" };
  if (exit.exitCode !== 0) {
    // Research R13 P3: `wsl.exe` printed its error text on stdout. The detail follows the contract §9 output tail rules.
    const out = stdout.take();
    const err = stderr.take();
    const joined = new Uint8Array(out.length + err.length);
    joined.set(out);
    joined.set(err, out.length);
    const detail = buildSubmoduleOutputTail(joined, stdout.limited || stderr.limited);
    return { ok: false, code: "WSL_UNAVAILABLE", result: { reason: "start-failed", text: TEXT["start-failed"](route.distro), ...(detail === "" ? {} : { detail }) } };
  }
  const parsed = stdout.limited ? null : parseWslProbe(stdout.take());
  return parsed === null ? { ok: false, code: "MALFORMED_GIT_OUTPUT" } : { ok: true, facts: parsed };
}

// Contract §11 "Distro start" and "Git per distro". `canceled` means that the signal ended the probe.
export async function probeWslGit(
  runner: WslRunner,
  route: Extract<WslRoute, { kind: "wsl" }>,
  target: WslProbeTarget,
): Promise<{ ok: true; git: Omit<WslGit, "gitInstallationId"> } | WslRefusal | { ok: false; canceled: true }> {
  const probe = await runWslProbe(runner, route, target);
  if (!probe.ok) return probe;
  const checked = checkWslProbe(route.distro, probe.facts, route.wslExecutable);
  return checked.ok ? { ok: true, git: { ...checked.git, guid: route.guid } } : checked;
}

// Contract §11 "Git per distro": a Git with another identity than the approved one gives GIT_CHANGED and a new confirmation.
export function gitChanged(known: { identity: string } | undefined, probed: { identity: string }): boolean {
  return known !== undefined && known.identity !== probed.identity;
}

// The WSL Git of a registration: the session Git of that distro when the probe found the same file, or a new Git after Use this Git.
// `changed`: the approved identity differs, so the registration ends GIT_CHANGED after the new confirmation.
export async function approveWslGit(
  runner: GitRunner,
  target: { operationId: string; bootstrapId: string },
  probed: Omit<WslGit, "gitInstallationId">,
  session: WslGit | undefined,
  saved: { identity: string } | undefined,
): Promise<{ ok: true; git: WslGit; reused: boolean; changed: boolean } | { ok: false; code: "GIT_CHANGED" | "DEADLINE" } | { ok: false; canceled: true }> {
  if (session !== undefined && !gitChanged(session, probed) && session.path === probed.path) {
    // Linux Git reads `PATH` when it runs, so every workspace of this Git takes the `PATH` of the latest probe.
    session.pathEnv = probed.pathEnv;
    return { ok: true, git: session, reused: true, changed: false };
  }
  const changed = gitChanged(session ?? saved, probed);
  const gitInstallationId = crypto.randomUUID();
  const reply = await runner.register({ operationId: target.operationId, bootstrapId: target.bootstrapId, gitInstallationId, confirm: true });
  // Contract §5 "Deadline outcomes": a walk deadline of a registration gives DEADLINE (T314).
  if ("stop" in reply) return { ok: false, code: "DEADLINE" };
  if (reply.result !== "approved") return changed ? { ok: false, code: "GIT_CHANGED" } : { ok: false, canceled: true };
  return { ok: true, git: { ...probed, gitInstallationId }, reused: false, changed };
}
