// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
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
});
