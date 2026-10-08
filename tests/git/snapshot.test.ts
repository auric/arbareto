// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { COMPARED_RAW_VERSION_BYTES, MUTATION_RAW_INDEX_BYTES } from "../../src/contracts/limits";
import { IndexFormatError, splitIndexLink } from "../../src/git-service/eligibility";
import {
  createSnapshotStore,
  indexFingerprint,
  policyFingerprint,
  readWorkingVersion,
  type Checked,
  type Head,
  type IndexEntry,
  type Observation,
  type PolicyInput,
} from "../../src/git-service/snapshot";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF08, buildF10, CapabilitySkip, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { indexEntries as oracleEntries, sha256 } from "./git-oracle";
import { caseTest } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/eligibility.ts", import.meta.dir);
printOrigin("../../src/git-service/snapshot.ts", import.meta.dir);

const TASK = "T081";
const TIMEOUT_MS = 120_000;

useFixtureRoot();

// Literal argument arrays in place of the T076 builders. Contract §7 "Missing objects": every app Git command starts with `--no-lazy-fetch`, and reads add `--no-optional-locks`.
const ABSOLUTE_GIT_DIR = ["--no-lazy-fetch", "rev-parse", "--absolute-git-dir"];
const INDEX_PATH = ["--no-lazy-fetch", "rev-parse", "--git-path", "index"];
const STATUS_V2 = ["--no-lazy-fetch", "--no-optional-locks", "status", "--porcelain=v2", "-z"];
const LS_FILES_TAGS = ["--no-lazy-fetch", "--no-optional-locks", "ls-files", "-z", "-v"];
// Oracle only. The service never asks Git for this path (contract §6, research.md R2).
const SHARED_INDEX_PATH = ["rev-parse", "--shared-index-path"];

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const git = (repo: string, args: string[]) => ownedGit(gitPath(), FIXTURE_ROOT, repo, args);
const text = (repo: string, args: string[]) => git(repo, args).toString("utf8");
const repoOf = (built: Built) => join(built.root, "repo");
const gitDirOf = (repo: string) => text(repo, ABSOLUTE_GIT_DIR).trim();
const indexPathOf = (repo: string) => resolve(repo, text(repo, INDEX_PATH).trim());
const rawIndex = (repo: string) => new Uint8Array(readFileSync(indexPathOf(repo)));
const sharedPathOf = (repo: string) => resolve(repo, text(repo, SHARED_INDEX_PATH).trim());
const linkOf = (repo: string) => basename(sharedPathOf(repo)).slice("sharedindex.".length);

// The oracle reads `ls-files --debug` (tests/git/git-oracle.ts). Its entries carry the three flags.
const entriesOf = (repo: string): IndexEntry[] =>
  oracleEntries(gitPath(), repo).map((e) => ({
    path: new Uint8Array(Buffer.from(e.path, "utf8")),
    stage: e.stage as IndexEntry["stage"],
    mode: e.mode,
    oid: e.oid,
    intentToAdd: e.intentToAdd,
    assumeUnchanged: e.assumeUnchanged,
    skipWorktree: e.skipWorktree,
  }));

// A failed or limited result throws, so no later assertion can pass on `false`.
const okValue = <T>(result: Checked<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.completeness));
  return result.value;
};

const fingerprintOf = async (repo: string, objectFormat: "sha1" | "sha256" = "sha1") =>
  indexFingerprint({ rawIndex: rawIndex(repo), objectFormat, gitDirectory: gitDirOf(repo), entries: entriesOf(repo) });

const branchHead = (built: Built): Head => {
  const head = built.facts.repos.repo!.head;
  return { state: "branch", target: head.target!, oid: head.oid! };
};

// A recognizable trust, configuration, and Git identity. Each test changes one part.
const POLICY: PolicyInput = {
  attributes: new Uint8Array(Buffer.from("multi.txt\0text\0set\0")),
  trust: { state: "untrusted", trustId: null },
  configurationFingerprint: "a".repeat(64),
  git: {
    gitInstallationId: "00000000-0000-4000-8000-000000000001",
    executablePath: "/opt/git-a/bin/git",
    executableIdentity: { file: { volumeSerial: "0".repeat(16), fileId: "1".repeat(32) }, versionOutput: "git version 2.55.0", digest: "b".repeat(64) },
  },
};

const UTC = "2026-10-04T12:00:00.000Z";

describe("indexFingerprint (data-model §4, research.md R2)", () => {
  caseTest(
    TASK,
    "F02 full index: the fingerprint covers the raw index digest and the Git-derived entries, and has no split state",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t081-f02"));
      const first = await fingerprintOf(repo);
      if (!first.ok) throw new Error(JSON.stringify(first.completeness));
      expect(first.value.sharedIndex).toBeNull();
      expect(first.value.rawIndexDigest).toBe(sha256(rawIndex(repo)));
      expect(first.value.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(okValue(await fingerprintOf(repo)).digest).toBe(first.value.digest);

      // The same raw bytes with one changed Git-derived flag give another digest.
      const entries = entriesOf(repo);
      entries[0] = { ...entries[0]!, assumeUnchanged: !entries[0]!.assumeUnchanged };
      const flipped = await indexFingerprint({ rawIndex: rawIndex(repo), objectFormat: "sha1", gitDirectory: gitDirOf(repo), entries });
      expect(okValue(flipped).digest).not.toBe(first.value.digest);

      // A staged change changes the raw bytes and the entries.
      put(repo, "keep.txt", "keep changed\n");
      git(repo, ["--literal-pathspecs", "add", "--", "keep.txt"]);
      const staged = okValue(await fingerprintOf(repo));
      expect(staged.digest).not.toBe(first.value.digest);
      expect(staged.rawIndexDigest).not.toBe(first.value.rawIndexDigest);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F10 split-index: the fingerprint names the link hash and covers the sharedindex file in the worktree Git directory",
    [],
    async () => {
      const repo = repoOf(buildF10(gitPath(), "t081-f10-split", "split-index"));
      const shared = sharedPathOf(repo);
      expect(resolve(shared, "..")).toBe(resolve(gitDirOf(repo)));
      // The oracle cannot read a broken split index, so the entries come from the intact one.
      const input = { rawIndex: rawIndex(repo), objectFormat: "sha1" as const, gitDirectory: gitDirOf(repo), entries: entriesOf(repo) };
      const fingerprint = () => indexFingerprint(input);
      const full = await fingerprintOf(repo);
      if (!full.ok) throw new Error(JSON.stringify(full.completeness));
      expect(full.value.sharedIndex).toEqual({ hash: linkOf(repo), digest: sha256(readFileSync(shared)) });

      // One changed byte inside the shared file, before its trailing hash, changes the digest. The raw index stays equal.
      const original = readFileSync(shared);
      const edited = Buffer.from(original);
      edited[16] = edited[16]! ^ 0xff;
      writeFileSync(shared, edited);
      const changed = okValue(await fingerprint());
      expect(changed.rawIndexDigest).toBe(full.value.rawIndexDigest);
      expect(changed.digest).not.toBe(full.value.digest);

      // read-cache.c `read_index_from`: the trailing hash of the shared file must equal the link hash.
      const badTrailer = Buffer.from(original);
      badTrailer[badTrailer.length - 1] = badTrailer[badTrailer.length - 1]! ^ 0xff;
      writeFileSync(shared, badTrailer);
      expect(await fingerprint()).toEqual({ ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } });

      // A missing shared file leaves the index unreadable.
      renameSync(shared, `${shared}.moved`);
      expect(await fingerprint()).toEqual({ ok: false, completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" } });

      // Contract §5 "Raw index eligible for mutation" includes the shared file. The read stops after the bound.
      writeFileSync(shared, "");
      truncateSync(shared, MUTATION_RAW_INDEX_BYTES);
      expect(await fingerprint()).toEqual({ ok: false, completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" } });

      writeFileSync(shared, original);
      expect(okValue(await fingerprint()).digest).toBe(full.value.digest);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an all-zero link hash names no shared file, so the fingerprint reads no file (hand-built index, gitformat-index \"Split index\")",
    [],
    async () => {
      // Git writes this link only with index.skipHash=true and --split-index, and then cannot read the index. So no Git fixture gives it.
      const body = Buffer.concat([Buffer.from("DIRC", "latin1"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]), Buffer.from("link", "latin1"), Buffer.from([0, 0, 0, 20]), Buffer.alloc(20)]);
      const checksum = new Bun.CryptoHasher("sha1").update(body).digest();
      const zero = "0".repeat(40);
      for (const raw of [Buffer.concat([body, checksum]), Buffer.concat([body, Buffer.alloc(20)])]) {
        expect(splitIndexLink(raw)).toBe(zero);
        const result = await indexFingerprint({ rawIndex: new Uint8Array(raw), objectFormat: "sha1", gitDirectory: join(fixtureDir("t081-zero-link"), "absent"), entries: [] });
        expect(okValue(result).sharedIndex).toEqual({ hash: zero, digest: null });
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F10 split-config: core.splitIndex=true with an unsplit index gives no split state, because the state comes from the raw bytes",
    [],
    async () => {
      const repo = repoOf(buildF10(gitPath(), "t081-f10-split-config", "split-config"));
      const result = await fingerprintOf(repo);
      expect(result.ok && result.value.sharedIndex).toBeNull();
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an absent index, a malformed index, an over-bound index, and an object ID of the wrong format give defined results",
    [],
    async () => {
      const empty = repoOf(buildF01(gitPath(), "t081-f01-empty", "empty"));
      const absent = await indexFingerprint({ rawIndex: null, objectFormat: "sha1", gitDirectory: gitDirOf(empty), entries: [] });
      expect(absent.ok && { raw: absent.value.rawIndexDigest, shared: absent.value.sharedIndex }).toEqual({ raw: null, shared: null });

      const repo = repoOf(buildF02(gitPath(), "t081-malformed"));
      const raw = rawIndex(repo);
      const input = { objectFormat: "sha1" as const, gitDirectory: gitDirOf(repo), entries: entriesOf(repo) };
      expect(await indexFingerprint({ ...input, rawIndex: raw.subarray(0, raw.length - 1) })).toEqual({ ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } });
      expect(await indexFingerprint({ ...input, rawIndex: new Uint8Array(MUTATION_RAW_INDEX_BYTES + 1) })).toEqual({
        ok: false,
        completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" },
      });
      // Data-model §2 `objectFormat`: object IDs are validated against the reported format.
      const sha256Ids = input.entries.map((e) => ({ ...e, oid: e.oid + "0".repeat(24) }));
      expect(await indexFingerprint({ ...input, rawIndex: raw, entries: sha256Ids })).toEqual({ ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } });
    },
    TIMEOUT_MS,
  );
});

describe("splitIndexLink index walk (Git gitformat-index.adoc)", () => {
  caseTest(
    TASK,
    "index version 4: index.skipHash=true gives no trailing checksum and no link, and a later split gives the link",
    [],
    () => {
      const repo = repoOf(buildF02(gitPath(), "t081-v4-skiphash"));
      git(repo, ["-c", "index.skipHash=true", "update-index", "--index-version", "4"]);
      const unsplit = rawIndex(repo);
      expect(Buffer.from(unsplit.subarray(0, 8)).toString("hex")).toBe("4449524300000004");
      expect(unsplit.subarray(unsplit.length - 20).every((b) => b === 0)).toBe(true);
      expect(splitIndexLink(unsplit)).toBeNull();
      // index.skipHash=true with --split-index writes an all-zero link, and Git then cannot read the index.
      git(repo, ["update-index", "--split-index"]);
      const raw = rawIndex(repo);
      expect(Buffer.from(raw.subarray(0, 8)).toString("hex")).toBe("4449524300000004");
      expect(linkOf(repo)).toMatch(/[^0]/);
      expect(splitIndexLink(raw)).toBe(linkOf(repo));
      expect(splitIndexLink(raw, "sha1")).toBe(linkOf(repo));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "index version 3 with extended flags: the walk reads the second flag field, and a later split gives the link",
    [],
    () => {
      const repo = repoOf(buildF10(gitPath(), "t081-v3", "flags"));
      const raw = rawIndex(repo);
      expect(Buffer.from(raw.subarray(4, 8)).toString("hex")).toBe("00000003");
      expect(splitIndexLink(raw)).toBeNull();
      git(repo, ["update-index", "--split-index"]);
      expect(splitIndexLink(rawIndex(repo))).toBe(linkOf(repo));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "SHA-256 split index: the link hash has 64 hex digits, and the wrong object format refuses the bytes",
    [],
    async () => {
      let built: Built;
      try {
        built = buildF08(gitPath(), "t081-sha256", "sha256");
      } catch (error) {
        if (error instanceof CapabilitySkip) return void console.log(`SKIP ${TASK} SHA-256 split index: missing capability ${error.capability} (unverified)`);
        throw error;
      }
      const repo = repoOf(built);
      git(repo, ["update-index", "--split-index"]);
      const raw = rawIndex(repo);
      expect(linkOf(repo)).toMatch(/^[0-9a-f]{64}$/);
      expect(splitIndexLink(raw)).toBe(linkOf(repo));
      expect(splitIndexLink(raw, "sha256")).toBe(linkOf(repo));
      expect(() => splitIndexLink(raw, "sha1")).toThrow(IndexFormatError);
      const result = await fingerprintOf(repo, "sha256");
      expect(result.ok && result.value.sharedIndex).toEqual({ hash: linkOf(repo), digest: sha256(readFileSync(sharedPathOf(repo))) });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "every truncation and every single-byte change gives a link, null, or IndexFormatError, and never another exception",
    [],
    () => {
      const repo = repoOf(buildF10(gitPath(), "t081-corrupt", "flags"));
      git(repo, ["update-index", "--index-version", "4"]);
      git(repo, ["update-index", "--split-index"]);
      const raw = rawIndex(repo);
      const outcome = (bytes: Uint8Array) => {
        try {
          const link = splitIndexLink(bytes);
          return link === null || /^[0-9a-f]{40}$/.test(link) ? "answer" : `bad ${link}`;
        } catch (error) {
          return error instanceof IndexFormatError ? "refused" : `exception ${String(error)}`;
        }
      };
      const seen = new Set<string>();
      for (let length = 0; length < raw.length; length++) seen.add(outcome(raw.slice(0, length)));
      for (let at = 0; at < raw.length; at++) {
        const changed = raw.slice();
        changed[at] = changed[at]! ^ 0xff;
        seen.add(outcome(changed));
      }
      expect([...seen].filter((s) => s !== "answer" && s !== "refused")).toEqual([]);
      expect(outcome(raw.slice(0, 11))).toBe("refused");
      expect(outcome(new Uint8Array(0))).toBe("refused");
    },
    TIMEOUT_MS,
  );
});

describe("indexEntries flags: Git outputs that detect them (Report for research.md)", () => {
  caseTest(
    TASK,
    "F10 flags: intent-to-add, assume-unchanged, and skip-worktree each have one Git output marker that agrees with the oracle",
    [],
    () => {
      const repo = repoOf(buildF10(gitPath(), "t081-flags", "flags"));
      const version = /^git version (\S+)/.exec(text(repo, ["version"]))![1]!;
      const where = process.platform === "linux" ? `Linux Git ${version}; Windows rerun pending` : `${process.platform} Git ${version}`;
      const oracle = new Map(entriesOf(repo).map((e) => [Buffer.from(e.path).toString("utf8"), e]));

      // git-status(1) porcelain v2: an ordinary record is `1 <XY> ...`. X `.` and Y `A` mark an intent-to-add entry.
      const records = text(repo, STATUS_V2).split("\0").filter((r) => r !== "");
      const ita = records.filter((r) => r.startsWith("1 .A ")).map((r) => r.split(" ").slice(8).join(" "));
      // ls-files(1) `-v`: a lowercase tag marks assume-unchanged. `-t`: the tag `S` marks skip-worktree.
      const tags = new Map(
        text(repo, LS_FILES_TAGS)
          .split("\0")
          .filter((r) => r !== "")
          .map((r) => [r.slice(2), r[0]!] as const),
      );
      expect(ita).toEqual([...oracle.values()].filter((e) => e.intentToAdd).map((e) => Buffer.from(e.path).toString("utf8")));
      for (const [path, entry] of oracle) {
        const tag = tags.get(path)!;
        expect({ path, assumeUnchanged: tag === tag.toLowerCase(), skipWorktree: tag.toUpperCase() === "S" }).toEqual({
          path,
          assumeUnchanged: entry.assumeUnchanged,
          skipWorktree: entry.skipWorktree,
        });
      }
      // `-v` gives the intent-to-add entry the plain tag `H`. So `ls-files -v` alone cannot detect intent-to-add.
      expect(tags.get("ita.txt")).toBe("H");
      expect(oracle.get("ita.txt")?.intentToAdd).toBe(true);
      expect([tags.get("keep.txt"), tags.get("conflict.txt")]).toEqual(["h", "S"]);

      // Both flags on one entry give the lowercase `s`.
      git(repo, ["update-index", "--assume-unchanged", "--", "conflict.txt"]);
      const both = text(repo, LS_FILES_TAGS).split("\0").find((r) => r.endsWith(" conflict.txt"));
      expect(both).toBe("s conflict.txt");

      console.log(`OBSERVATION ${TASK}: intent-to-add: detected by ${JSON.stringify(STATUS_V2)} as ordinary record "1 .A" (mH and mI "000000") (${where})`);
      console.log(`OBSERVATION ${TASK}: assume-unchanged: detected by ${JSON.stringify(LS_FILES_TAGS)} as a lowercase tag ("h", or "s" with skip-worktree) (${where})`);
      console.log(`OBSERVATION ${TASK}: skip-worktree: detected by ${JSON.stringify(LS_FILES_TAGS)} as tag "S" (or "s" with assume-unchanged) (${where})`);
    },
    TIMEOUT_MS,
  );
});

describe("workingVersions (data-model §4)", () => {
  caseTest(
    TASK,
    "existence, type, mode, raw-byte digest, and the normalized identity of selected paths, within the named bound",
    [],
    async () => {
      const built = buildF02(gitPath(), "t081-working");
      const repo = repoOf(built);
      const at = (path: string) => new Uint8Array(Buffer.from(path, "utf8"));
      const blob = "c".repeat(40);

      const file = await readWorkingVersion(repo, at("multi.txt"), "WHOLE_FILE_STAGE_INPUT_BYTES", blob);
      const bytes = readFileSync(join(repo, "multi.txt"));
      expect(file.ok && file.value).toMatchObject({ exists: true, type: "file", size: bytes.length, rawDigest: sha256(bytes), normalized: blob });
      expect(file.ok && file.value.exists && typeof file.value.mode).toBe("number");

      expect(await readWorkingVersion(repo, at("absent.txt"), "COMPARED_RAW_VERSION_BYTES", null)).toEqual({ ok: true, value: { path: at("absent.txt"), exists: false } });

      mkdirSync(join(repo, "folder"));
      const folder = await readWorkingVersion(repo, at("folder"), "COMPARED_RAW_VERSION_BYTES", null);
      expect(folder.ok && folder.value).toMatchObject({ exists: true, type: "directory" });

      put(repo, "at-limit.bin", new Uint8Array(COMPARED_RAW_VERSION_BYTES));
      put(repo, "over-limit.bin", new Uint8Array(COMPARED_RAW_VERSION_BYTES + 1));
      const atLimit = await readWorkingVersion(repo, at("at-limit.bin"), "COMPARED_RAW_VERSION_BYTES", null);
      expect(atLimit.ok && atLimit.value).toMatchObject({ type: "file", size: COMPARED_RAW_VERSION_BYTES });
      expect(await readWorkingVersion(repo, at("over-limit.bin"), "COMPARED_RAW_VERSION_BYTES", null)).toEqual({
        ok: false,
        completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "COMPARED_RAW_VERSION_BYTES" },
      });

      for (const bad of ["", "/multi.txt", "../outside.txt", "a/../multi.txt", "./multi.txt", "folder/", "a//b"]) {
        expect({ bad, result: await readWorkingVersion(repo, at(bad), "COMPARED_RAW_VERSION_BYTES", null) }).toEqual({
          bad,
          result: { ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } },
        });
      }

      const outside = fixtureDir("t081-working-outside");
      put(outside, "secret.txt", "outside\n");
      try {
        symlinkSync(outside, join(repo, "linked-dir"), "dir");
        symlinkSync("multi.txt", join(repo, "link.txt"), "file");
      } catch (error) {
        return void console.log(`SKIP ${TASK} working-version links: missing capability symlink (${String(error)}) (unverified)`);
      }
      // diff-lib.c `check_removed`: Git treats a path behind a symbolic link as removed.
      expect(await readWorkingVersion(repo, at("linked-dir/secret.txt"), "COMPARED_RAW_VERSION_BYTES", null)).toEqual({ ok: true, value: { path: at("linked-dir/secret.txt"), exists: false } });
      const link = await readWorkingVersion(repo, at("link.txt"), "COMPARED_RAW_VERSION_BYTES", blob);
      expect(link.ok && link.value).toMatchObject({ exists: true, type: "symlink", rawDigest: sha256(Buffer.from("multi.txt")), normalized: null });
    },
    TIMEOUT_MS,
  );
});

describe("workingVersions path swap (data-model §4)", () => {
  const at = (path: string) => new Uint8Array(Buffer.from(path, "utf8"));

  // An atomic save writes a temporary file and renames it over the original.
  const atomicSave = (repo: string, name: string, content: string) => {
    put(repo, `${name}.tmp`, content);
    renameSync(join(repo, `${name}.tmp`), join(repo, name));
  };

  caseTest(
    TASK,
    "one atomic save between the lstat and the open: the retry reads the new file",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t081-swap-once"));
      put(repo, "swap.txt", "before\n");
      let calls = 0;
      const result = await readWorkingVersion(repo, at("swap.txt"), "COMPARED_RAW_VERSION_BYTES", null, {
        afterLstat: async () => {
          if (++calls === 1) atomicSave(repo, "swap.txt", "after save\n");
        },
      });
      expect(calls).toBe(2);
      expect(okValue(result)).toMatchObject({ exists: true, type: "file", size: 11, rawDigest: sha256(Buffer.from("after save\n")) });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an atomic save before each open: the read ends with REPOSITORY_CHANGED",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t081-swap-twice"));
      put(repo, "swap.txt", "save 0\n");
      let calls = 0;
      const result = await readWorkingVersion(repo, at("swap.txt"), "COMPARED_RAW_VERSION_BYTES", null, {
        afterLstat: async () => atomicSave(repo, "swap.txt", `save ${++calls}\n`),
      });
      expect(calls).toBe(2);
      expect(result).toEqual({ ok: false, completeness: { state: "failed", code: "REPOSITORY_CHANGED" } });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a file swapped for a link to an outside file: the retry reports the link, and the outside file is never read",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t081-swap-link"));
      const outside = fixtureDir("t081-swap-outside");
      const secret = join(outside, "secret.txt");
      put(outside, "secret.txt", "outside secret\n");
      put(repo, "swap.txt", "inside\n");
      let kind = "symlink";
      let calls = 0;
      const result = await readWorkingVersion(repo, at("swap.txt"), "COMPARED_RAW_VERSION_BYTES", null, {
        afterLstat: async () => {
          if (++calls > 1) return;
          renameSync(join(repo, "swap.txt"), join(repo, "swap.moved"));
          try {
            symlinkSync(secret, join(repo, "swap.txt"), "file");
          } catch {
            // A hard link is no reparse point. The second lstat then finds a regular file of the worktree.
            kind = "hard link";
            linkSync(secret, join(repo, "swap.txt"));
          }
        },
      });
      console.log(`${TASK} path swap: ${kind}`);
      if (kind === "symlink") {
        expect(calls).toBe(1);
        expect(okValue(result)).toMatchObject({ exists: true, type: "symlink", rawDigest: sha256(Buffer.from(secret)), normalized: null });
      } else {
        expect(okValue(result)).toMatchObject({ exists: true, type: "file", rawDigest: sha256(Buffer.from("outside secret\n")) });
      }
    },
    TIMEOUT_MS,
  );
});

describe("policyFingerprint (data-model §4)", () => {
  caseTest(
    TASK,
    "the digest covers relevant attributes, trust approval, configuration, and Git installation identity",
    [],
    () => {
      const base = policyFingerprint(POLICY);
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      expect(policyFingerprint({ ...POLICY })).toBe(base);
      const variants: PolicyInput[] = [
        { ...POLICY, attributes: new Uint8Array(Buffer.from("multi.txt\0text\0unset\0")) },
        { ...POLICY, trust: { state: "approved", trustId: "00000000-0000-4000-8000-000000000002" } },
        { ...POLICY, trust: { state: "changed", trustId: null } },
        { ...POLICY, configurationFingerprint: "d".repeat(64) },
        { ...POLICY, git: { ...POLICY.git, gitInstallationId: "00000000-0000-4000-8000-000000000003" } },
        { ...POLICY, git: { ...POLICY.git, executablePath: "/opt/git-b/bin/git" } },
        { ...POLICY, git: { ...POLICY.git, executableIdentity: { ...POLICY.git.executableIdentity, digest: "e".repeat(64) } } },
        { ...POLICY, git: { ...POLICY.git, executableIdentity: { ...POLICY.git.executableIdentity, versionOutput: "git version 2.56.0" } } },
        { ...POLICY, git: { ...POLICY.git, executableIdentity: { ...POLICY.git.executableIdentity, file: { volumeSerial: "0".repeat(16), fileId: "2".repeat(32) } } } },
      ];
      const digests = variants.map(policyFingerprint);
      expect(new Set([base, ...digests]).size).toBe(variants.length + 1);
      // Data-model §3: the configuration fingerprint is 64 lowercase hex digits.
      expect(() => policyFingerprint({ ...POLICY, configurationFingerprint: "A".repeat(64) })).toThrow();
    },
    TIMEOUT_MS,
  );
});

describe("snapshot record, generation counter, and status snapshot retention (data-model §4, contract §8)", () => {
  caseTest(
    TASK,
    "records every field, advances the generation only on a changed observation, and applies the retention rule",
    [],
    async () => {
      const built = buildF02(gitPath(), "t081-store");
      const repo = repoOf(built);
      const repositoryId = crypto.randomUUID();
      const fingerprint = async () => {
        const result = await fingerprintOf(repo);
        if (!result.ok) throw new Error(JSON.stringify(result.completeness));
        return result.value;
      };
      const observation = async (overrides: Partial<Observation> = {}): Promise<Observation> => ({
        repositoryId,
        head: branchHead(built),
        indexFingerprint: await fingerprint(),
        indexEntries: entriesOf(repo),
        workingVersions: [],
        policyFingerprint: policyFingerprint(POLICY),
        operationState: "normal",
        completeness: { state: "complete" },
        entryCount: 4,
        observedAt: UTC,
        ...overrides,
      });

      const store = createSnapshotStore();
      expect(store.lookup(repositoryId, 0, crypto.randomUUID())).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
      expect(store.register(repositoryId)).toBe(0);
      expect(store.retained(repositoryId)).toBeNull();

      const first = await observation();
      const one = store.record(first);
      expect(one).toMatchObject({ ...first, generation: 0 });
      expect(one.snapshotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect({ entryCount: one.entryCount, observedAt: one.observedAt, entries: one.indexEntries.length }).toEqual({ entryCount: 4, observedAt: UTC, entries: 4 });
      expect(store.lookup(repositoryId, 0, one.snapshotId)).toEqual({ ok: true, snapshot: one });

      // A full read replaces the snapshot. An equal observation keeps the generation.
      const two = store.record(await observation({ observedAt: "2026-10-04T12:00:01Z", entryCount: 5 }));
      expect({ generation: two.generation, same: two.snapshotId === one.snapshotId }).toEqual({ generation: 0, same: false });
      expect(store.lookup(repositoryId, 0, one.snapshotId)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
      // A `check: "changes"` read with an equal tuple keeps the retained snapshot (contract §8 "Change check").
      expect(store.retained(repositoryId)).toBe(two);

      // A staged change changes `indexFingerprint`, so the generation advances.
      put(repo, "keep.txt", "keep changed again\n");
      git(repo, ["--literal-pathspecs", "add", "--", "keep.txt"]);
      const three = store.record(await observation());
      expect(three.generation).toBe(1);
      // `readEntries` checks the generation first, then the snapshot.
      expect(store.lookup(repositoryId, 0, three.snapshotId)).toEqual({ ok: false, code: "REPOSITORY_CHANGED" });
      expect(store.lookup(repositoryId, 0, crypto.randomUUID())).toEqual({ ok: false, code: "REPOSITORY_CHANGED" });
      expect(store.lookup(repositoryId, 1, crypto.randomUUID())).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
      expect(store.lookup(repositoryId, 1, three.snapshotId)).toEqual({ ok: true, snapshot: three });

      // HEAD, the policy, the operation state, and a bound working version each advance it.
      const four = store.record(await observation({ head: { state: "detached", oid: built.facts.repos.repo!.head.oid! } }));
      const five = store.record(await observation({ policyFingerprint: policyFingerprint({ ...POLICY, configurationFingerprint: "f".repeat(64) }) }));
      const six = store.record(await observation({ policyFingerprint: policyFingerprint({ ...POLICY, configurationFingerprint: "f".repeat(64) }), operationState: "merging" }));
      const working = await readWorkingVersion(repo, new Uint8Array(Buffer.from("multi.txt")), "COMPARED_RAW_VERSION_BYTES", null);
      if (!working.ok) throw new Error("working version");
      const seven = store.record(
        await observation({ policyFingerprint: policyFingerprint({ ...POLICY, configurationFingerprint: "f".repeat(64) }), operationState: "merging", workingVersions: [working.value] }),
      );
      expect([four, five, six, seven].map((s) => s.generation)).toEqual([2, 3, 4, 5]);

      // A limited read also replaces the snapshot. Its completeness carries the bound name.
      const limited = store.record(await observation({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" }, indexFingerprint: null, policyFingerprint: null }));
      expect({ generation: limited.generation, completeness: limited.completeness }).toEqual({
        generation: 6,
        completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" },
      });

      // Invalid observations start no record.
      expect(() => store.record({ ...first, entryCount: -1 })).toThrow();
      expect(() => store.record({ ...first, entryCount: 1.5 })).toThrow();
      expect(() => store.record({ ...first, observedAt: "2026-10-04 12:00" })).toThrow();
      expect(() => store.record({ ...first, indexFingerprint: null })).toThrow();
      expect(() => store.record({ ...first, completeness: { state: "failed", code: "NOT_A_CODE" as never } })).toThrow();
      expect(() => store.record({ ...first, repositoryId: crypto.randomUUID() })).toThrow();
      expect(store.retained(repositoryId)).toBe(limited);
      expect(store.generation(repositoryId)).toBe(6);

      // A workspace release releases the snapshot. A new service session has no snapshot.
      store.release(repositoryId);
      expect(store.lookup(repositoryId, 6, limited.snapshotId)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
      expect(store.retained(repositoryId)).toBeNull();
      expect(store.register(repositoryId)).toBe(0);
      store.record(first);
      store.releaseAll();
      expect(store.retained(repositoryId)).toBeNull();
      expect(createSnapshotStore().lookup(repositoryId, 0, one.snapshotId)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    },
    TIMEOUT_MS,
  );

  caseTest(
    "T110",
    "bind adds or replaces a working version in the retained observation and keeps the generation and the snapshot ID",
    [],
    async () => {
      const built = buildF02(gitPath(), "t110-bind");
      const repo = repoOf(built);
      const repositoryId = crypto.randomUUID();
      const fingerprint = okValue(await fingerprintOf(repo));
      const observation = (workingVersions: Observation["workingVersions"]): Observation => ({
        repositoryId,
        head: branchHead(built),
        indexFingerprint: fingerprint,
        indexEntries: entriesOf(repo),
        workingVersions,
        policyFingerprint: policyFingerprint(POLICY),
        operationState: "normal",
        completeness: { state: "complete" },
        entryCount: 4,
        observedAt: UTC,
      });
      const version = async (path: string) => okValue(await readWorkingVersion(repo, new Uint8Array(Buffer.from(path)), "COMPARED_RAW_VERSION_BYTES", null));

      const store = createSnapshotStore();
      const multi = await version("multi.txt");
      expect(store.bind(repositoryId, 0, multi)).toBe(false);
      store.register(repositoryId);
      expect(store.bind(repositoryId, 0, multi)).toBe(false);
      const base = store.record(observation([]));

      expect(store.bind(repositoryId, 0, multi)).toBe(true);
      const keep = await version("keep.txt");
      expect(store.bind(repositoryId, 0, keep)).toBe(true);
      const bound = store.retained(repositoryId)!;
      expect({ generation: bound.generation, snapshotId: bound.snapshotId }).toEqual({ generation: 0, snapshotId: base.snapshotId });
      // `Buffer.compare` order: "keep.txt" sorts before "multi.txt".
      expect(bound.workingVersions).toEqual([keep, multi]);
      expect(store.retainedEqual(observation([keep, multi]))).toBe(bound);
      expect(store.retainedEqual(observation([]))).toBeNull();

      // The same path replaces its version.
      put(repo, "multi.txt", "changed for bind\n");
      const changed = await version("multi.txt");
      expect(store.bind(repositoryId, 0, changed)).toBe(true);
      expect(store.retained(repositoryId)!.workingVersions).toEqual([keep, changed]);
      expect(store.retainedEqual(observation([keep, multi]))).toBeNull();
      expect(store.retainedEqual(observation([keep, changed]))).toBe(store.retained(repositoryId));
      expect(store.record(observation([keep, changed])).generation).toBe(0);

      // A stale generation binds nothing.
      expect(store.bind(repositoryId, 1, multi)).toBe(false);
      expect(store.retained(repositoryId)!.workingVersions).toEqual([keep, changed]);
    },
    TIMEOUT_MS,
  );
});
