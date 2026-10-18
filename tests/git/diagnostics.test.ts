// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildSubmoduleOutputTail } from "../../src/contracts/submodules";
import { discoverRepository } from "../../src/git-service/discovery";
import { createCollector } from "../../src/git-service/git-runner";
import { redactUrlUserInfo } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { createBunRunner } from "./bun-runner";
import { FIXTURE_ROOT, fixtureDir, fixtureEnv, fixtureGit, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF02, buildF17, put } from "./fixtures";
import { GIT } from "./git-binary";
import { load, rows } from "./history-view-harness";
import { caseTest, openService, type Service } from "./service-harness";

printOrigin("../../src/git-service/discovery.ts", import.meta.dir);
printOrigin("../../src/git-service/trust.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/contracts/submodules.ts", import.meta.dir);

const TASK = "T073";
const MERGED = "T308";
const TIMEOUT_MS = 120_000;
// Research R2: the first discovery query.
const FIRST_QUERY = ["--no-lazy-fetch", "rev-parse", "--is-bare-repository", "--is-inside-git-dir"];
// Contract §6 "Registration bootstrap": the remedy text of the merged refusal.
const UNAVAILABLE_REMEDY = "Run `git status` in this folder";
// Contract §7 "URL user information": the redacted form of each canary URL.
const REDACTED_URL = "https://<redacted>@host.example/";

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
    MERGED,
    "Git stderr of a failing discovery holds a credential canary, and the merged refusal carries it only redacted in outputTail",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t073-discovery-stderr").root, "repo");
      // Git dies on a bad numeric value and prints that value (Git `config.c` `die_bad_number`).
      fixtureGit(git, repo, ["config", "core.abbrev", CANARIES.discovery]);
      const proc = Bun.spawnSync([git, ...FIRST_QUERY], { cwd: repo, env: fixtureEnv({ LC_ALL: "C" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect({ exitCode: proc.exitCode, canary: text(proc.stderr).includes(CANARIES.discovery) }).toEqual({ exitCode: 128, canary: true });

      const runner = createBunRunner({ git, directory: fixtureDir("t073-discovery-stderr-runner"), environment: serviceEnv() });
      try {
        const gitInstallationId = crypto.randomUUID();
        const probe = runner.addContext("gitProbe", git);
        expect(await runner.register({ operationId: crypto.randomUUID(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
        // Records the stderr bytes of discovery call 1 and passes them on.
        const seen: Uint8Array[] = [];
        const recorded = {
          ...runner,
          run: async (call: Parameters<typeof runner.run>[0]) => {
            if (call.arguments.join(" ") !== FIRST_QUERY.join(" ")) return runner.run(call);
            const stderr = createCollector({ maxBytes: 64 * 1024 });
            const exit = await runner.run({ ...call, stderr });
            seen.push(stderr.take());
            call.stderr.push(seen[0]!);
            return exit;
          },
        };
        const result = await discoverRepository(recorded, { operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", repo), gitInstallationId, directory: repo, gitSelectedPath: git });
        const refusal = (result.ok ? undefined : result.refusal) as { code?: string; path?: string; remedy?: { text?: string; command?: string | null }; outputTail?: string } | undefined;
        expect(seen.length).toBe(1);
        expect(text(seen[0]!)).toContain(CANARIES.discovery);
        expect({ code: refusal?.code, path: refusal?.path, text: refusal?.remedy?.text, command: refusal?.remedy?.command ?? null, outputTail: refusal?.outputTail }).toEqual({
          code: "REPOSITORY_UNAVAILABLE",
          path: repo,
          text: UNAVAILABLE_REMEDY,
          command: null,
          outputTail: buildSubmoduleOutputTail(seen[0]!, false),
        });
        expect(refusal?.outputTail).toContain(REDACTED_URL);
        expect(leaks(refusal)).toEqual([]);
      } finally {
        await runner.dispose();
      }
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
        expect((await service.openHistory(repositoryId, (await service.readWorkspace(repositoryId)).result!.generation)).state).toBe("succeeded");

        // Git dies on a bad boolean value and prints that value. Discovery does not read `status.renames`, so only the status read fails.
        fixtureGit(git, repo, ["config", "status.renames", CANARIES.stderr]);
        const failedFrom = service.runner.calls.length;
        const failed = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
        expect(failed.state).not.toBe("succeeded");
        expect(service.runner.calls.slice(failedFrom).some((c) => c.exit?.exitCode === 128)).toBe(true);
        await service.readTrust(repositoryId);

        // The failing discovery call 1 gives the merged refusal through the service. Its outputTail holds Git's message with the canary redacted.
        const other = join(buildF02(git, "t073-service-discovery").root, "repo");
        fixtureGit(git, other, ["config", "core.abbrev", CANARIES.discovery]);
        const refused = await service.chooseRepository(other);
        const gitStderr = new Uint8Array(Bun.spawnSync([git, ...FIRST_QUERY], { cwd: other, env: fixtureEnv({ LC_ALL: "C" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stderr);
        const result = refused.result as { remedy?: { text?: string; command?: string | null }; outputTail?: string } | undefined;
        expect({ state: refused.state, code: refused.code, text: result?.remedy?.text, command: result?.remedy?.command ?? null, outputTail: result?.outputTail }).toEqual({
          state: "failed",
          code: "REPOSITORY_UNAVAILABLE",
          text: UNAVAILABLE_REMEDY,
          command: null,
          outputTail: buildSubmoduleOutputTail(gitStderr, false),
        });
        expect(result?.outputTail).toContain(REDACTED_URL);

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

describe("output tail containment (contract §7)", () => {
  // A plain canary, not a URL, so the redaction leaves it in the output tail.
  const TAIL_CANARY = `${CANARY}OUTPUT-TAIL`;

  caseTest(
    "T321",
    "a canary in the stderr of a refused discovery call 1 appears only in outputTail, never in the session log, a progress event, or a diagnostic",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t321-output-tail").root, "repo");
      // Git dies on a bad numeric value and prints that value (Git `config.c` `die_bad_number`).
      fixtureGit(git, repo, ["config", "core.abbrev", TAIL_CANARY]);
      const service = await openService({ git, name: "t321-output-tail" });
      try {
        const refused = await service.chooseRepository(repo);
        const outputTail = (refused.result as { outputTail?: string } | undefined)?.outputTail;
        expect({ state: refused.state, code: refused.code, canary: outputTail?.includes(TAIL_CANARY) }).toEqual({ state: "failed", code: "REPOSITORY_UNAVAILABLE", canary: true });
        const fields = leaks(service.responses).map((leak) => leak.slice(0, leak.indexOf(": ")));
        expect({ count: fields.length, outsideTail: fields.filter((field) => !field.endsWith(".result.outputTail")) }).toEqual({ count: 1, outsideTail: [] });
        expect(leaks(service.log())).toEqual([]);
        expect(leaks(service.progress)).toEqual([]);
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
        const approved = await service.approveTrust(repositoryId);
        expect(approved.state).toBe("succeeded");
        const read = await service.readWorkspace(repositoryId);
        expect(read.state).toBe("succeeded");
        const untracked = read.result!.entries.filter((e) => e.category === "untracked");
        for (const name of NAMES) {
          const entry = untracked.find((e) => e.path === name);
          expect({ name, path: entry?.path, bytes: entry && Buffer.from(entry.pathBytes, "base64").toString("utf8") }).toEqual({ name, path: name, bytes: name });
        }
        const view = await service.openHistory(repositoryId, read.result!.generation);
        expect(view.state).toBe("succeeded");
        const loaded = await load(service, repositoryId, view.result!.viewId, { end: true });
        const history = await rows(service, repositoryId, view.result!.viewId, { row: 0 }, loaded.result!.rows, "rows");
        expect(history.state).toBe("succeeded");
        const subjects = history.result!.rows!.map((row) => row.subject);
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
