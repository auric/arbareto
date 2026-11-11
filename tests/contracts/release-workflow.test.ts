// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// T024: every rule of contracts/release.md §1 on .github/workflows/release.yml. Before T025 the file is absent, so every case fails.
// The workflow is a YAML file, not a module, so this file prints its path as the ORIGIN line.

const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml");
const PACKAGE = join(import.meta.dir, "..", "..", "package.json");
const TAURI_CONF = join(import.meta.dir, "..", "..", "src-tauri", "tauri.conf.json");
console.log(`ORIGIN ${WORKFLOW}`);
console.log(`ORIGIN ${PACKAGE}`);
console.log(`ORIGIN ${TAURI_CONF}`);

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

  test("GH_TOKEN is only in the env of the publish step, and the publish job env has no GH_TOKEN", () => {
    expect(Object.hasOwn(jobs.publish?.env ?? {}, "GH_TOKEN")).toBe(false);
    expect(Object.hasOwn(workflow.env ?? {}, "GH_TOKEN")).toBe(false);
    const holders = Object.entries(jobs).flatMap(([job, j]) => (j.steps ?? []).flatMap((s) => (s.env?.GH_TOKEN === undefined ? [] : [`${job}/${s.name} ${s.env.GH_TOKEN}`])));
    expect(holders).toEqual(["publish/Publish the release ${{ github.token }}"]);
  });

  test("the publish script checks the tag commit after the last upload and before --draft=false, and only there", () => {
    const script = (steps("publish").find((s) => s.name === "Publish the release")?.run ?? "").split("\n");
    const at = (pattern: RegExp) => script.flatMap((line, i) => (pattern.test(line) ? [i] : []));
    const check = at(/RELEASE_CHECK not-tag-commit/);
    const tagApi = at(/gh api "repos\/\$env:GITHUB_REPOSITORY\/commits\/refs\/tags\/\$env:TAG"/);
    const writes = at(/^\s*gh release (create|upload) /);
    const publish = at(/^\s*gh release edit \$env:TAG --draft=false /);
    expect([check.length, tagApi.length, publish.length]).toEqual([1, 1, 1]);
    expect(writes.length).toBe(2);
    expect(tagApi[0]!).toBeGreaterThan(Math.max(...writes));
    expect(check[0]!).toBeGreaterThan(tagApi[0]!);
    expect(check[0]!).toBeLessThan(publish[0]!);
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

  test("each Install Bun step compares the zip hash with BUN_ZIP_SHA256 and exits 1 with RELEASE_CHECK pin bun-windows-x64.zip", () => {
    const pin = 'if ($hash -ne $env:BUN_ZIP_SHA256) { [Console]::Error.WriteLine("RELEASE_CHECK pin bun-windows-x64.zip $hash"); exit 1 }';
    for (const job of ["build", "publish"]) {
      const install = steps(job).filter((s) => s.name === "Install Bun");
      expect(install.length).toBe(1);
      expect((install[0]!.run ?? "").split("\n").map((line) => line.trim())).toContain(pin);
    }
  });

  // bun-windows-x64.zip holds only bun.exe, so Install Bun gives no bunx (T029 dry run 1). tauri-cli 2.12.0 build.rs:132 and 203: build runs
  // beforeBuildCommand, and only a build without --no-bundle runs the bundler. Only the bundler gets makensis.exe (tauri-bundler 2.10.0 nsis/mod.rs:80-96).
  test("every package script that a build step runs starts only a tool that an earlier step installs", async () => {
    const scripts = ((await Bun.file(PACKAGE).json()) as { scripts: Record<string, string> }).scripts;
    const hooks = ((await Bun.file(TAURI_CONF).json()) as { build?: { beforeBuildCommand?: string; beforeBundleCommand?: string } }).build ?? {};
    for (const overlay of ["tauri.preview.conf.json", "tauri.windows.conf.json"]) {
      expect(Object.hasOwn(await Bun.file(join(TAURI_CONF, "..", overlay)).json(), "build")).toBe(false);
    }
    const NSIS = '"$LOCALAPPDATA/tauri/NSIS/makensis.exe"';
    const build = steps("build");
    const bunAt = build.findIndex((s) => s.name === "Install Bun");
    const rustAt = build.findIndex((s) => s.name === "Install Rust and the Tauri CLI");
    expect(bunAt).toBeGreaterThanOrEqual(0);
    expect(rustAt).toBeGreaterThan(bunAt);
    const bad: string[] = [];
    const seen: string[] = [];
    let bundled = false;
    const visit = (command: string, from: string, rust: boolean, depth: number) => {
      if (depth > 8) return void bad.push(`${from}: depth`);
      // shortcut: splits on " && " without a shell parser. Outside "…" strings, it refuses a part with ", ', `, | or ;. Use a parser when Bun exposes one.
      for (const part of command.split(" && ")) {
        const words = part.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+ )+/, "").split(" ");
        const [tool, sub, arg] = words;
        if (/["'`|;]/.test(part.replace(/"[^"]*"/g, ""))) bad.push(`${from}: ${part}`);
        else if (tool === "bun" && sub === "run") {
          const script = scripts[arg ?? ""];
          if (script === undefined) bad.push(`${from}: ${part}`);
          else {
            seen.push(arg!);
            visit(script, arg!, rust, depth + 1);
          }
        } else if (tool === "bun") continue;
        else if ((tool === "cargo" || tool === "rustc") && rust) {
          if (tool !== "cargo" || sub !== "tauri" || (arg !== "build" && arg !== "bundle")) continue;
          if (arg === "build" && hooks.beforeBuildCommand !== undefined) visit(hooks.beforeBuildCommand, "beforeBuildCommand", rust, depth + 1);
          if (arg === "bundle" || !words.includes("--no-bundle")) {
            if (hooks.beforeBundleCommand !== undefined) visit(hooks.beforeBundleCommand, "beforeBundleCommand", rust, depth + 1);
            bundled = true;
          }
        } else if (!(tool === NSIS && bundled)) bad.push(`${from}: ${part}`);
      }
    };
    build.forEach((step, index) => {
      if (index <= bunAt) return;
      for (const line of (step.run ?? "").split("\n")) {
        const match = /^\s*(bun run \S+)\s*$/.exec(line);
        if (match !== null) visit(match[1]!, step.name ?? `step ${index}`, index > rustAt, 0);
        else if (/bun run|bunx/.test(line)) bad.push(`${step.name ?? `step ${index}`}: ${line.trim()}`);
      }
    });
    expect(seen).toContain("build:frontend");
    expect(seen).toContain("package:preview:bundle");
    expect(bad).toEqual([]);
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
    "  if ($args[0] -eq 'api') { if (($args -join ' ') -match '\\.assets\\[\\]\\.name') { $env:DRAFT_ASSETS -split ',' } elseif ($args[1] -like '*/commits/refs/tags/*') { $env:TAG_COMMIT } else { 'true' } }",
    "}",
    "function bun { $global:LASTEXITCODE = 0; Join-Path $env:RUNNER_TEMP 'notes.md' }",
  ].join("\n");

  const BUILT = "1111111111111111111111111111111111111111";
  function publish(label: string, assets: string[], tagCommit = BUILT): { code: number | null; stderr: string; gh: string } {
    const temp = join(scratch, label);
    mkdirSync(join(temp, "release-files"), { recursive: true });
    for (const name of PLANNED) writeFileSync(join(temp, "release-files", name), name);
    const script = steps("publish").find((s) => s.name === "Publish the release")?.run;
    expect(script).toBeDefined();
    writeFileSync(join(temp, "publish.ps1"), `${STUBS}\n${script}\nexit 0\n`);
    const log = join(temp, "gh.log");
    writeFileSync(log, "");
    const env = { ...process.env, RUNNER_TEMP: temp, TAG: "v0.1.0", SIGNING: "off", GITHUB_REPOSITORY: "auric/arbareto", GH_LOG: log, DRAFT_ASSETS: assets.join(","), GITHUB_SHA: BUILT, TAG_COMMIT: tagCommit };
    const proc = Bun.spawnSync([PWSH!, "-NoProfile", "-NonInteractive", "-File", join(temp, "publish.ps1")], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return { code: proc.exitCode, stderr: proc.stderr.toString(), gh: readFileSync(log, "utf8") };
  }

  test("a draft asset outside the planned files gives RELEASE_CHECK exists and no upload", () => {
    const result = publish("stale", [...PLANNED, "arbareto_0.0.9_x64-setup.exe"]);
    expect([result.code, result.stderr.trim()]).toEqual([1, "RELEASE_CHECK exists v0.1.0"]);
    expect(result.gh).not.toContain("release upload");
  });

  test("a tag on another commit than GITHUB_SHA after the upload gives RELEASE_CHECK not-tag-commit and no publish", () => {
    const moved = "2222222222222222222222222222222222222222";
    const result = publish("moved", PLANNED.slice(1), moved);
    expect([result.code, result.stderr.trim()]).toEqual([1, `RELEASE_CHECK not-tag-commit v0.1.0 ${moved}`]);
    const calls = result.gh.split(/\r?\n/);
    const upload = calls.findIndex((c) => c.startsWith("release upload v0.1.0"));
    const check = calls.findIndex((c) => c.startsWith("api repos/auric/arbareto/commits/refs/tags/v0.1.0"));
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(upload);
    expect(result.gh).not.toContain("--draft=false");
  });

  test("a draft with only planned assets gets the upload and the publish", () => {
    const result = publish("planned", PLANNED.slice(1));
    expect(result.code).toBe(0);
    expect(result.gh).toContain("release upload v0.1.0");
    expect(result.gh).toContain("release edit v0.1.0 --draft=false");
  });
});
