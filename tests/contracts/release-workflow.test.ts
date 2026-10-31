// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// T024: every rule of contracts/release.md §1 on .github/workflows/release.yml. Before T025 the file is absent, so every case fails.
// The workflow is a YAML file, not a module, so this file prints its path as the ORIGIN line.

const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml");
console.log(`ORIGIN ${WORKFLOW}`);

type Env = Record<string, unknown>;
type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Env; with?: Record<string, unknown>; "continue-on-error"?: unknown };
type Job = { "runs-on"?: unknown; env?: Env; needs?: unknown; if?: unknown; environment?: unknown; permissions?: unknown; "continue-on-error"?: unknown; steps?: Step[] };
type Workflow = { on?: Record<string, unknown>; env?: Env; permissions?: unknown; jobs?: Record<string, Job> };

const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
const jobs = workflow.jobs ?? {};
const steps = (job: string) => jobs[job]?.steps ?? [];
const runs = (job: string) => steps(job).map((s) => s.run ?? "");
const allSteps = Object.values(jobs).flatMap((j) => j.steps ?? []);

describe("release workflow", () => {
  test("workflow permissions are empty", () => {
    expect(workflow.permissions).toEqual({});
  });

  test("the triggers are push of v* tags, push of release-dry-run, and workflow_dispatch, and no other", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on?.push).toEqual({ tags: ["v*"], branches: ["release-dry-run"] });
    expect(workflow.on?.workflow_dispatch ?? null).toBeNull();
  });

  test("the jobs are build and publish", () => {
    expect(Object.keys(jobs).sort()).toEqual(["build", "publish"]);
  });

  test("build runs on windows-2025 with exactly contents: read and actions: read, and no environment", () => {
    expect(jobs.build?.["runs-on"]).toBe("windows-2025");
    expect(jobs.build?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(Object.hasOwn(jobs.build ?? {}, "environment")).toBe(false);
  });

  test("publish needs build, uses the release environment, runs only for v* tag pushes, and has exactly its three permissions", () => {
    expect(jobs.publish?.needs).toBe("build");
    expect(jobs.publish?.environment).toBe("release");
    expect(jobs.publish?.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
    expect(jobs.publish?.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  });

  test("every uses: names a full 40-hex commit ID", () => {
    const uses = allSteps.flatMap((s) => (s.uses === undefined ? [] : [s.uses]));
    expect(uses.length).toBeGreaterThan(0);
    for (const value of uses) expect(value).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  test("no actions/cache and no continue-on-error: true", () => {
    expect(allSteps.filter((s) => s.uses?.startsWith("actions/cache"))).toEqual([]);
    expect([...allSteps, ...Object.values(jobs)].filter((s) => s["continue-on-error"] !== undefined && s["continue-on-error"] !== false)).toEqual([]);
  });

  // Plan.md D1: either key replaces the `/Brepro` rustflags of `.cargo/config.toml`. Windows environment names ignore case.
  test("no env map at workflow, job, or step level has a RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS key", () => {
    const maps = [workflow.env, ...Object.values(jobs).map((j) => j.env), ...allSteps.map((s) => s.env)].filter((e) => e !== undefined);
    expect(maps.length).toBeGreaterThan(1);
    const keys = maps.flatMap((e) => Object.keys(e!).map((k) => k.toUpperCase()));
    expect(keys.filter((k) => k === "RUSTFLAGS" || k === "CARGO_ENCODED_RUSTFLAGS")).toEqual([]);
  });

  // GitHub docs "Using secrets in GitHub Actions": `if:` cannot read secrets, so the job env carries the comparison result.
  test("the build job env sets SIGNPATH_TOKEN_SET from the SignPath token secret", () => {
    expect(jobs.build?.env?.SIGNPATH_TOKEN_SET).toBe("${{ secrets.SIGNPATH_API_TOKEN != '' }}");
  });

  test("each SignPath step runs only when ARBARETO_SIGNING is signpath", () => {
    const signpath = allSteps.filter((s) => s.uses?.toLowerCase().startsWith("signpath/"));
    expect(signpath.length).toBe(2);
    for (const step of signpath) expect(step.if).toBe("vars.ARBARETO_SIGNING == 'signpath'");
  });

  test("the build job calls check.ts before and after the build, both package scripts, notices-text.ts, hunspell-source.ts, and sums.ts write", () => {
    const build = runs("build");
    const at = (pattern: RegExp) => build.flatMap((r, i) => (pattern.test(r) ? [i] : []));
    const checks = at(/bun scripts\/release\/check\.ts /);
    const exes = at(/^bun run package:preview:exes$/m);
    const bundle = at(/^bun run package:preview:bundle$/m);
    expect(exes.length).toBe(1);
    expect(bundle.length).toBe(1);
    expect(checks.length).toBe(2);
    expect(checks[0]!).toBeLessThan(exes[0]!);
    expect(checks[1]!).toBeGreaterThan(bundle[0]!);
    for (const pattern of [/bun scripts\/release\/notices-text\.ts /, /bun scripts\/release\/hunspell-source\.ts /, /bun scripts\/release\/sums\.ts write /]) {
      expect(at(pattern).length).toBe(1);
    }
  });

  test("the publish job checks the private flag, runs sums.ts verify and actions/attest, and creates a draft pre-release with --verify-tag", () => {
    const publish = runs("publish").join("\n");
    expect(jobs.publish?.steps?.some((s) => s.uses?.startsWith("actions/attest@"))).toBe(true);
    expect(publish).toMatch(/bun scripts\/release\/sums\.ts verify /);
    expect(publish).toMatch(/^\s*gh release create .*--draft --prerelease --verify-tag /m);
    expect(JSON.stringify(jobs.publish)).toContain("${{ github.event.repository.private }}");
  });

  // GitHub docs "Security hardening for GitHub Actions": an expression inside a script is a script injection risk. Steps pass values through env.
  test("no run block holds an expression", () => {
    expect(allSteps.filter((s) => s.run?.includes("${{"))).toEqual([]);
  });

  test("the SignPath token secret appears only in the two SignPath api-token inputs and in SIGNPATH_TOKEN_SET", () => {
    const found: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string") {
        if (value.includes("secrets.SIGNPATH_API_TOKEN")) found.push(`${path} ${value}`);
      } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}/${key}`);
      }
    };
    walk(workflow, "");
    const input = "${{ secrets.SIGNPATH_API_TOKEN }}";
    const signpath = steps("build").flatMap((s, i) => (s.uses?.toLowerCase().startsWith("signpath/") ? [`/jobs/build/steps/${i}/with/api-token ${input}`] : []));
    expect(signpath.length).toBe(2);
    expect(found.sort()).toEqual([...signpath, "/jobs/build/env/SIGNPATH_TOKEN_SET ${{ secrets.SIGNPATH_API_TOKEN != '' }}"].sort());
  });

  test("in publish, sums.ts verify runs before actions/attest, and actions/attest runs before the publish step", () => {
    const publish = steps("publish");
    const verify = publish.findIndex((s) => /bun scripts\/release\/sums\.ts verify /.test(s.run ?? ""));
    const attest = publish.findIndex((s) => s.uses?.startsWith("actions/attest@"));
    const release = publish.findIndex((s) => /^\s*gh release create /m.test(s.run ?? ""));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(attest);
    expect(attest).toBeLessThan(release);
  });
});

// The publish script runs in pwsh with stub `gh` and `bun` functions. A runner without pwsh skips these cases.
const PWSH = Bun.which("pwsh");
describe.skipIf(PWSH === null)("publish script with a reused draft", () => {
  const scratch = mkdtempSync(join(tmpdir(), "arbareto-release-workflow-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const PLANNED = ["SHA256SUMS.txt", "arbareto-0.1.0-hunspell-source.tar.gz", "arbareto-0.1.0-third-party-notices.txt", "arbareto_0.1.0_x64-setup.exe"];
  // GitHub runs a pwsh step with `$ErrorActionPreference = 'stop'` first.
  const STUBS = [
    "$ErrorActionPreference = 'stop'",
    "function gh {",
    "  Add-Content -LiteralPath $env:GH_LOG -Value ($args -join ' ')",
    "  $global:LASTEXITCODE = 0",
    "  if ($args[0] -eq 'api') { if (($args -join ' ') -match '\\.assets\\[\\]\\.name') { $env:DRAFT_ASSETS -split ',' } else { 'true' } }",
    "}",
    "function bun { $global:LASTEXITCODE = 0; Join-Path $env:RUNNER_TEMP 'notes.md' }",
  ].join("\n");

  function publish(label: string, assets: string[]): { code: number | null; stderr: string; gh: string } {
    const temp = join(scratch, label);
    mkdirSync(join(temp, "release-files"), { recursive: true });
    for (const name of PLANNED) writeFileSync(join(temp, "release-files", name), name);
    const script = steps("publish").find((s) => s.name === "Publish the release")?.run;
    expect(script).toBeDefined();
    writeFileSync(join(temp, "publish.ps1"), `${STUBS}\n${script}\nexit 0\n`);
    const log = join(temp, "gh.log");
    writeFileSync(log, "");
    const env = { ...process.env, RUNNER_TEMP: temp, TAG: "v0.1.0", SIGNING: "off", GITHUB_REPOSITORY: "auric/arbareto", GH_LOG: log, DRAFT_ASSETS: assets.join(",") };
    const proc = Bun.spawnSync([PWSH!, "-NoProfile", "-NonInteractive", "-File", join(temp, "publish.ps1")], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return { code: proc.exitCode, stderr: proc.stderr.toString(), gh: readFileSync(log, "utf8") };
  }

  test("a draft asset outside the planned files gives RELEASE_CHECK exists and no upload", () => {
    const result = publish("stale", [...PLANNED, "arbareto_0.0.9_x64-setup.exe"]);
    expect([result.code, result.stderr.trim()]).toEqual([1, "RELEASE_CHECK exists v0.1.0"]);
    expect(result.gh).not.toContain("release upload");
  });

  test("a draft with only planned assets gets the upload and the publish", () => {
    const result = publish("planned", PLANNED.slice(1));
    expect(result.code).toBe(0);
    expect(result.gh).toContain("release upload v0.1.0");
    expect(result.gh).toContain("release edit v0.1.0 --draft=false");
  });
});
