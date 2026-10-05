// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { classifyDiscoveryFailure } from "../../src/git-service/discovery";
import { redactUrlUserInfo } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureEnv, fixtureGit, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF02, buildF17, put } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, openService, type Service } from "./service-harness";

printOrigin("../../src/git-service/discovery.ts", import.meta.dir);
printOrigin("../../src/git-service/trust.ts", import.meta.dir);

const TASK = "T073";
const TIMEOUT_MS = 120_000;
const SELECTED_GIT = "C:\\Program Files\\Git\\cmd\\git.exe";

// Every credential canary holds this text. Each sits in the user information of a URL.
const CANARY = "ARBARETO-T073-";
const url = (name: string) => `https://u:${CANARY}${name}@host.example/`;
const CANARIES = {
  remote: url("REMOTE"),
  insteadOf: url("INSTEADOF"),
  stderr: url("STDERR"),
  hookOutput: url("HOOK-OUTPUT"),
  hookCommand: url("HOOK-COMMAND"),
  discovery: url("DISCOVERY"),
};

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Puts the remote URL, `url.<URL>.insteadOf`, configured hook, and hook output canaries into an F02 copy. The hooks also log each run.
function armCredentialCanaries(git: string, repo: string): string {
  const config = (key: string, value: string) => fixtureGit(git, repo, ["config", key, value]);
  config("remote.origin.url", `${CANARIES.remote}repo.git`);
  config(`url.${CANARIES.insteadOf}.insteadOf`, "https://host.example/");
  config("hook.t073.command", `echo ${CANARIES.hookCommand}`);
  config("hook.t073.event", "post-index-change");
  const log = join(repo, ".git", "t073-hook.log");
  for (const hook of ["pre-commit", "post-index-change", "post-checkout", "reference-transaction"]) {
    chmodSync(put(repo, `.git/hooks/${hook}`, `#!/bin/sh\necho ${hook} >> '${log.replaceAll("\\", "/")}'\necho ${CANARIES.hookOutput}\necho ${CANARIES.hookOutput} >&2\n`), 0o755);
  }
  return log;
}

// Each string value of `value` with its path, so a failed check names the field.
function leaks(value: unknown, at = "$"): string[] {
  if (typeof value === "string") return value.includes(CANARY) ? [`${at}: ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => leaks(item, `${at}[${i}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => [...(key.includes(CANARY) ? [`${at} key ${key}`] : []), ...leaks(item, `${at}.${key}`)]);
  return [];
}

// Every `diagnostic` field in `value`.
function diagnostics(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(diagnostics);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => (key === "diagnostic" ? [item, ...diagnostics(item)] : diagnostics(item)));
}

describe("credential canaries outside the service (L)", () => {
  caseTest(
    TASK,
    "Git stderr of a failing discovery holds a credential canary, and the discovery refusal holds none",
    [],
    () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t073-discovery-stderr").root, "repo");
      // Git dies on a bad numeric value and prints that value (Git `config.c` `die_bad_number`).
      fixtureGit(git, repo, ["config", "core.abbrev", CANARIES.discovery]);
      const proc = Bun.spawnSync([git, "--no-lazy-fetch", "rev-parse", "--is-bare-repository", "--is-inside-git-dir"], {
        cwd: repo,
        env: fixtureEnv({ LC_ALL: "C" }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ exitCode: proc.exitCode, canary: text(proc.stderr).includes(CANARIES.discovery) }).toEqual({ exitCode: 128, canary: true });
      const refusal = classifyDiscoveryFailure({ exitCode: proc.exitCode, stderr: new Uint8Array(proc.stderr), directory: repo, gitSelectedPath: SELECTED_GIT });
      expect(refusal.code).toBe("REPOSITORY_UNAVAILABLE");
      expect(leaks(refusal)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the redaction removes the remote URL, url.<URL>.insteadOf subsection, and hook command canaries from the real Git configuration listing",
    [],
    () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t073-listing").root, "repo");
      armCredentialCanaries(git, repo);
      const listing = ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", "config", "list", "--show-scope", "--show-origin", "-z"]).toString("utf8");
      for (const canary of [CANARIES.remote, CANARIES.insteadOf, CANARIES.hookCommand]) expect(listing).toContain(canary);
      const redacted = redactUrlUserInfo(listing);
      expect(leaks(redacted)).toEqual([]);
      // Contract §7 "URL user information": the text before the last `@` of the authority becomes `<redacted>`.
      expect(redacted).toContain("url.https://<redacted>@host.example/.insteadof\nhttps://host.example/");
    },
    TIMEOUT_MS,
  );
});

describe("credential canaries through the service (contract §7, data-model §7 `diagnostic`)", () => {
  caseTest(
    TASK,
    "no remote URL, url.<URL>.insteadOf, Git stderr, or hook canary appears in a response, progress event, session log, or diagnostic",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t073-service").root, "repo");
      const hookLog = armCredentialCanaries(git, repo);
      const service: Service = await openService({ git, name: "t073-service" });
      try {
        const { repositoryId } = await service.register(repo);
        const trust = await service.readTrust(repositoryId);
        expect(trust.state).toBe("succeeded");
        // `url.<URL>.insteadOf` and `hook.<name>.command` reach `readTrust` as a key and as an allowlisted value.
        const keys = trust.result!.entries.map((e) => e.key);
        expect(keys.some((key) => key.startsWith("url.") && key.includes("<redacted>"))).toBe(true);
        expect((await service.readWorkspace(repositoryId)).state).toBe("succeeded");
        expect((await service.readWorkspace(repositoryId, { refresh: true, check: "full" })).state).toBe("succeeded");
        expect((await service.readHistory(repositoryId, (await service.readWorkspace(repositoryId)).result!.generation)).state).toBe("succeeded");

        // Git dies on a bad boolean value and prints that value. Discovery does not read `status.renames`, so only the status read fails.
        fixtureGit(git, repo, ["config", "status.renames", CANARIES.stderr]);
        const failedFrom = service.runner.calls.length;
        const failed = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
        expect(failed.state).not.toBe("succeeded");
        expect(service.runner.calls.slice(failedFrom).some((c) => c.exit?.exitCode === 128)).toBe(true);
        await service.readTrust(repositoryId);

        // The failing discovery reaches the classifier through the service.
        const other = join(buildF02(git, "t073-service-discovery").root, "repo");
        fixtureGit(git, other, ["config", "core.abbrev", CANARIES.discovery]);
        expect((await service.chooseRepository(other)).state).not.toBe("succeeded");

        expect(existsSync(hookLog)).toBe(false);
        expect(leaks(service.responses)).toEqual([]);
        expect(leaks(service.progress)).toEqual([]);
        expect(leaks(service.log())).toEqual([]);
        expect(leaks(diagnostics(service.responses))).toEqual([]);
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

describe("inert repository text (contract §1, §9 \"Commit failure output\")", () => {
  // Windows refuses `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, and `*` in names, so the markup sits in the commit subject.
  const NAMES = ["$(ni arbareto-t073-marker).txt", "`whoami`.txt", "%PATH%.txt", ";& calc.txt", "{{constructor}}.txt"];
  const SUBJECT = `<img src=x onerror="alert(1)"> <script>alert('x')</script> $(ni arbareto-t073-marker) \`whoami\` %PATH%`;

  caseTest(
    TASK,
    "repository text that looks like markup or a command stays inert string data in responses",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const built = buildF17(git, "t073-inert", "trust");
      const repo = join(built.root, "repo");
      fixtureGit(git, repo, ["commit", "-q", "--no-verify", "--allow-empty", "-m", SUBJECT]);
      for (const name of NAMES) put(repo, name, "inert\n");
      const service = await openService({ git, name: "t073-inert" });
      try {
        const { repositoryId } = await service.register(repo);
        const trust = await service.readTrust(repositoryId);
        const approved = await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation);
        expect(approved.state).toBe("succeeded");
        const read = await service.readWorkspace(repositoryId);
        expect(read.state).toBe("succeeded");
        const untracked = read.result!.entries.filter((e) => e.category === "untracked");
        for (const name of NAMES) {
          const entry = untracked.find((e) => e.path === name);
          expect({ name, path: entry?.path, bytes: entry && Buffer.from(entry.pathBytes, "base64").toString("utf8") }).toEqual({ name, path: name, bytes: name });
        }
        const history = await service.readHistory(repositoryId, read.result!.generation);
        expect(history.state).toBe("succeeded");
        const subjects = history.result!.rows.map((row) => row.subject);
        expect(subjects).toContain(SUBJECT);
        expect(subjects).toContain("base <b>markup</b>");
        const found = (readdirSync(FIXTURE_ROOT, { recursive: true }) as string[]).filter((p) => basename(p) === "arbareto-t073-marker");
        expect(found).toEqual([]);
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
