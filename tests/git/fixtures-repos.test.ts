// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F15, F17 to F20, and the 401 server (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTRIBUTION_EVIDENCE_BYTES, ATTRIBUTION_EVIDENCE_RECORDS } from "../../src/contracts/limits";
import { canaryRuns, expectHunks, fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { sha256 } from "./git-oracle";
import { gitOpenssl, loopbackCertificate, startHttp401 } from "./http-401";
import * as F from "./fixtures";

// research.md R14 S18 saw the 401 failure after 1.9 seconds. Bun ends the process after this wait.
const HTTP_401_WAIT_MS = 30_000;

describeGit("fixture builders: F15, F17 to F20, and the 401 server", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, builtRepos, filemodeTest } = fixtureChecks(git);

    for (const refFormat of ["files", "reftable"] as const) {
      for (const variant of ["base", "reflog-records", "reflog-bytes"] as const) {
        test(`F20 ${variant} ${refFormat}`, () =>
          check(`F20 ${variant} ${refFormat}`, (n) => F.buildF20(git, n, variant, refFormat), (g, b) => {
            const repo = join(b.root, "repo");
            expectHunks(g, repo, b);
            expect(git1(g, repo, ["rev-parse", "--show-ref-format"]).toString().trim()).toBe(refFormat);
            if (variant === "base") return;
            // Contract §8 "Commit attribution read": the caps count the printed records and bytes of this read.
            F.inflateHeadReflog(repo, variant, refFormat);
            const out = git1(g, repo, ["log", "-g", "-z", "--date=raw", "--no-show-signature", "--no-decorate", "--no-color", "--format=%H%x00%gd%x00%gn%x00%ge%x00%gs", "HEAD", "--"]);
            const records = out.filter((byte) => byte === 0).length / 5;
            console.log(`F20 ${variant} ${refFormat}: ${records} records, ${out.length} bytes`);
            if (variant === "reflog-records") expect([records > ATTRIBUTION_EVIDENCE_RECORDS, out.length < ATTRIBUTION_EVIDENCE_BYTES]).toEqual([true, true]);
            else expect([records < ATTRIBUTION_EVIDENCE_RECORDS, out.length > ATTRIBUTION_EVIDENCE_BYTES]).toEqual([true, true]);
          }), TIMEOUT);
      }
    }

    test("F15", () =>
      check("F15", (n) => F.buildF15(git, n), (_g, b) => {
        expect(existsSync(join(b.root, "plain", ".git"))).toBe(false);
        const hostile = b.facts.notes.hostile as string[];
        expect(hostile.length).toBe(process.platform === "win32" ? F.POWERSHELL_QUOTES.length : 0);
        if (hostile.length > 0) expect(readdirSync(join(b.root, "hostile")).sort()).toEqual([...hostile].sort());
      }), TIMEOUT);

    test("F17 trust", () =>
      check("F17 trust", (n) => F.buildF17(git, n, "trust"), (g, b) => {
        const repo = join(b.root, "repo");
        const local = git1(g, repo, ["config", "--local", "--list"]).toString();
        for (const key of ["filter.canary.clean=./tools/clean.sh", "filter.proc.process=", "core.fsmonitor=", "diff.external=", "diff.tcv.textconv="]) expect(local).toContain(key);
        expect(existsSync(join(repo, "tools", "clean.sh"))).toBe(true);
        // The clean canary must be live: `hash-object --path` applies the clean filter of that path.
        expect(canaryRuns(b).clean).toBe(false);
        ownedGit(git, FIXTURE_ROOT, repo, ["hash-object", "--path=data.dat", "--stdin"], { input: Buffer.from("x\n") });
        expect(canaryRuns(b).clean).toBe(true);
      }), TIMEOUT);

    // The canaries must run from their files: the clean filter and the hook canary need the executable bit.
    test("F17 trust canaries run through the clean filter and the pre-commit hook", () => {
      const b = F.buildF17(git, "f17-canaries", "trust");
      const repo = join(b.root, "repo");
      builtRepos.push(repo);
      git1(git, repo, ["hash-object", "--path=data.dat", "data.dat"]);
      git1(git, repo, ["hook", "run", "pre-commit"]);
      expect(canaryRuns(b)).toMatchObject({ clean: true, "pre-commit": true });
    }, TIMEOUT);

    for (const variant of ["partial-reset-soft", "partial-read-tree"] as const) {
      test(`F17 ${variant}`, () =>
        check(`F17 ${variant}`, (n) => F.buildF17(git, n, variant), (g, b) => {
          const clone = join(b.root, "clone");
          const missing = b.facts.notes.missingBlobs as string[];
          expect(missing.length).toBe(2);
          for (const oid of missing) expect(git1(g, clone, ["--no-lazy-fetch", "cat-file", "-e", oid], [1, 128]).length).toBe(0);
          expect(canaryRuns(b)).toEqual({ uploadpack: false });
          // The canary must be live: one lazy fetch outside the facts runs it.
          git1(g, clone, ["cat-file", "-p", missing[0]!]);
          expect(canaryRuns(b)).toEqual({ uploadpack: true });
        }), TIMEOUT);
    }

    for (const variant of ["files", "reftable"] as const) {
      test(`F18 ${variant}`, () =>
        check(`F18 ${variant}`, (n) => F.buildF18(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          expect(git1(g, repo, ["rev-parse", "--show-ref-format"]).toString().trim()).toBe(variant);
          if (variant === "files") expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).toContain("refs/heads/packed");
        }), TIMEOUT);
    }

    for (const variant of ["linear", "merge", "octopus", "skewed", "roots", "long", "wide", "encoding", "shallow", "sha256"] as const) {
      test(`F19 ${variant}`, () =>
        check(`F19 ${variant}`, (n) => F.buildF19(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          const expected = b.facts.notes.parents as Record<string, string[]>;
          const shallow = (b.facts.notes.shallow as string[] | undefined) ?? [];
          const rows = git1(g, repo, ["rev-list", "--parents", "HEAD"]).toString().trim().split("\n").map((r) => r.split(" "));
          for (const [oid, ...parents] of rows) if (!shallow.includes(oid!)) expect(parents).toEqual(expected[oid!]!);
          if (variant === "shallow") {
            expect(readFileSync(join(repo, ".git", "shallow"), "utf8").trim().split("\n")).toEqual(shallow);
            expect(rows.length).toBe(b.facts.notes.depth as number);
          } else {
            expect(rows.length).toBe(Object.keys(expected).length);
          }
          if (variant === "encoding") {
            const raw = git1(g, repo, ["cat-file", "commit", "HEAD"]);
            expect(raw.includes(Buffer.from("encoding ISO-8859-1\n"))).toBe(true);
            expect(raw.includes(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]))).toBe(true);
          }
        }), TIMEOUT);
    }

    // research.md R14 S18: Git without a prompt gets the 401 answer and exits 128. The `https` mode trusts the test certificate through an owned global file.
    for (const mode of ["http", "https"] as const) {
      test(`http-401 ${mode}`, async () => {
        const dir = fixtureDir(`http-401-${mode}`);
        const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
        let tls: { key: string; cert: string } | undefined;
        if (mode === "https") {
          const openssl = gitOpenssl(git);
          if (openssl === null) {
            console.log("SKIP http-401 https: missing capability openssl (unverified)");
            return;
          }
          tls = loopbackCertificate(openssl, join(dir, "keys"));
          env.GIT_CONFIG_GLOBAL = join(dir, "global.gitconfig");
          writeFileSync(env.GIT_CONFIG_GLOBAL, `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[http]\n\tsslCAInfo = ${tls.cert.replaceAll("\\", "/")}\n`);
        }
        const server = startHttp401(tls);
        try {
          const proc = Bun.spawn([git, "ls-remote", server.url], { cwd: dir, env: fixtureEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: HTTP_401_WAIT_MS });
          expect({ exit: await proc.exited, requested: server.requests() >= 1 }).toEqual({ exit: 128, requested: true });
        } finally {
          server.stop();
        }
      }, TIMEOUT);
    }

    filemodeTest();
  });
});
