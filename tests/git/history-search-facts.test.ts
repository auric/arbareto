// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T004: the matching probe and the matching facts (plan.md P0.5, research.md R4 and R13, contract Δ3 "Matching probe").
// The FR-023 and FR-024 cases are assertions. The other R4 and R13 facts are OBSERVATION lines (tasks.md "Test harness rules").

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { MATCHING_PROBE_COMMITS, MATCHING_PROBE_RUNS, MATCHING_PROBE_STREAM, MATCHING_PROBE_TIP } from "../../src/contracts/matching-probe";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY, FIXTURE_HOME, FIXTURE_ROOT, fixtureEnv, useFixtureRoot } from "./fixture-root";
import { describeGit, fixtureGitPath } from "./git-binary";

printOrigin("../../src/contracts/matching-probe.ts", import.meta.dir);

const TASK = "T004";
// Contract Δ3 `searchHistory`. LC_ALL overrides LANG and LC_CTYPE (POSIX "Internationalization Variables").
const LOCALE = { LC_ALL: "C.UTF-8", LANG: "C", LC_CTYPE: "C" };

describeGit("matching probe facts", (gitPath) => {
  useFixtureRoot();
  let probe = "";

  const git = (args: string[], env: Record<string, string> = {}, input?: Uint8Array) => {
    const proc = Bun.spawnSync([fixtureGitPath(gitPath), ...args], { cwd: FIXTURE_ROOT, env: fixtureEnv({ ...LOCALE, ...env }), stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
    return { exitCode: proc.exitCode, out: proc.stdout.toString("utf8") };
  };
  const oidsOf = (out: string) => out.split("\n").filter((l) => l !== "");
  const ownedConfig = (name: string, extra: string) => {
    const path = join(FIXTURE_HOME, name);
    writeFileSync(path, `[user]\n\tname = ${FIXED_IDENTITY.name}\n\temail = ${FIXED_IDENTITY.email}\n${extra}`);
    return path;
  };
  // The contract argv with the probe patterns. Stdin holds the probe tip.
  const search = (grep: readonly string[], env: Record<string, string> = {}, options: string[] = ["--fixed-strings"]) => {
    const args = [`--git-dir=${probe}`, "--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "-c", "i18n.logOutputEncoding=UTF-8", "rev-list", "--date-order", ...options, "--regexp-ignore-case", ...grep.map((g) => `--grep=${g}`), "--stdin"];
    const result = git(args, env, Buffer.from(`${MATCHING_PROBE_TIP}\n`));
    expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 0 });
    return oidsOf(result.out);
  };
  const runsAgree = (env: Record<string, string>) => MATCHING_PROBE_RUNS.every((run) => JSON.stringify(search(run.grep, env).sort()) === JSON.stringify([...run.matches].sort()));

  test("the probe stream imports into a bare repository and gives the contract OIDs", () => {
    probe = mkdtempSync(join(FIXTURE_ROOT, "probe-"));
    expect(git(["init", "--bare", "-q", "--template=", "--object-format=sha1", probe]).exitCode).toBe(0);
    expect(git([`--git-dir=${probe}`, "fast-import", "--quiet"], {}, MATCHING_PROBE_STREAM).exitCode).toBe(0);
    const listed = git([`--git-dir=${probe}`, "rev-list", "--reverse", MATCHING_PROBE_TIP]);
    expect(oidsOf(listed.out)).toEqual(MATCHING_PROBE_COMMITS.map((c) => c.oid));
  });

  test("the FR-023 and FR-024 cases match as the contract expects, under another log output encoding", () => {
    // FR-024: a hostile owned configuration. The `-c` value of the argv must win (git-config(1) "CONFIGURATION FILE" precedence).
    const env = { GIT_CONFIG_GLOBAL: ownedConfig("latin1.gitconfig", "[i18n]\n\tlogOutputEncoding = ISO-8859-1\n") };
    MATCHING_PROBE_RUNS.forEach((run, r) => {
      const found = new Set(search(run.grep, env));
      const label = (oid: string) => MATCHING_PROBE_COMMITS.find((c) => c.oid === oid)!.label;
      console.log(`OBSERVATION ${TASK}: probe run ${r + 1} (${run.grep.join(" ")}) matched [${[...found].map(label).join(", ")}]; did not match [${run.nonMatches.filter((o) => !found.has(o)).map(label).join(", ")}]`);
      expect({ run: r + 1, matches: [...found].map(label).sort() }).toEqual({ run: r + 1, matches: run.matches.map(label).sort() });
    });
  });

  test("init --template= copies no template file", () => {
    const templates = join(FIXTURE_ROOT, "templates");
    mkdirSync(join(templates, "info"), { recursive: true });
    writeFileSync(join(templates, "info", "arbareto-template-marker"), "marker\n");
    const files = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => !statSync(join(dir, p)).isDirectory()).map((p) => p.replaceAll("\\", "/")).sort();
    // git-init(1) "TEMPLATE DIRECTORY": `--template` comes before GIT_TEMPLATE_DIR.
    const empty = join(FIXTURE_ROOT, "init-empty-template");
    const control = join(FIXTURE_ROOT, "init-env-template");
    expect(git(["init", "--bare", "-q", "--template=", "--object-format=sha1", empty], { GIT_TEMPLATE_DIR: templates }).exitCode).toBe(0);
    expect(git(["init", "--bare", "-q", "--object-format=sha1", control], { GIT_TEMPLATE_DIR: templates }).exitCode).toBe(0);
    console.log(`OBSERVATION ${TASK}: init --bare --template= wrote ${JSON.stringify(files(empty))}`);
    expect(files(control)).toContain("info/arbareto-template-marker");
    expect(files(empty)).not.toContain("info/arbareto-template-marker");
    const defaults = join(FIXTURE_ROOT, "init-default-template");
    expect(git(["init", "--bare", "-q", "--object-format=sha1", defaults]).exitCode).toBe(0);
    const fromTemplate = files(defaults).filter((p) => !files(empty).includes(p));
    console.log(`OBSERVATION ${TASK}: the default template adds ${JSON.stringify(fromTemplate)}; init --template= adds none of them (experiment)`);
    expect(files(empty).filter((p) => fromTemplate.includes(p))).toEqual([]);
  });

  test("record: an explicit --git-dir gets no ownership refusal", () => {
    // `GIT_TEST_ASSUME_DIFFERENT_OWNER` makes `ensure_valid_ownership` fail (Git setup.c). The discovery run is the control.
    const other = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
    const discovered = git(["-C", probe, "rev-parse", "--git-dir"], other).exitCode;
    const explicit = git([`--git-dir=${probe}`, "rev-parse", "--git-dir"], other).exitCode;
    if (discovered === 0) {
      console.log(`OBSERVATION ${TASK}: GIT_TEST_ASSUME_DIFFERENT_OWNER did not refuse discovery; the ownership fact stays unverified`);
    } else {
      console.log(`OBSERVATION ${TASK}: with another owner, discovery exits ${discovered}, and an explicit --git-dir exits ${explicit}; the probe runs ${runsAgree(other) ? "give" : "do not give"} the contract matches (experiment)`);
    }
    expect(explicit).toBe(0);
  });

  test("record: --fixed-strings overrides grep.patternType=perl in the owned global configuration", () => {
    const env = { GIT_CONFIG_GLOBAL: ownedConfig("perl.gitconfig", "[grep]\n\tpatternType = perl\n") };
    // Every probe message starts with "probe ". The regular expression `probe.` matches all messages. The literal text matches none.
    const regex = search(["probe."], env, []).length;
    const literal = search(["probe."], env).length;
    console.log(`OBSERVATION ${TASK}: with grep.patternType=perl, --grep=probe. matched ${regex} of ${MATCHING_PROBE_COMMITS.length} without --fixed-strings and ${literal} with it (experiment)`);
    expect(regex).toBe(MATCHING_PROBE_COMMITS.length);
  });

  test("record: the -c value wins over an inherited GIT_CONFIG_PARAMETERS", () => {
    const inherited = { GIT_CONFIG_PARAMETERS: "'i18n.logoutputencoding'='ISO-8859-1'" };
    const get = (config: string[]) => git([`--git-dir=${probe}`, ...config, "config", "--get", "i18n.logOutputEncoding"], inherited).out.trim();
    const alone = get([]);
    const withC = get(["-c", "i18n.logOutputEncoding=UTF-8"]);
    console.log(`OBSERVATION ${TASK}: with an inherited GIT_CONFIG_PARAMETERS, config --get gives ${JSON.stringify(alone)} alone and ${JSON.stringify(withC)} with -c; the probe runs ${runsAgree(inherited) ? "give" : "do not give"} the contract matches (experiment)`);
    expect(alone).toBe("ISO-8859-1");
  });

  test("record: the probe without a UTF-8 locale", () => {
    console.log(`OBSERVATION ${TASK}: with LC_ALL=C, the probe runs ${runsAgree({ LC_ALL: "C" }) ? "give" : "do not give"} the contract matches (experiment)`);
  });

  test("fs.rm removes the probe folder", async () => {
    await rm(probe, { recursive: true, force: true });
    expect(existsSync(probe)).toBe(false);
  });
});
