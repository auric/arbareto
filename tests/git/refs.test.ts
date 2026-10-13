// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T356: `readRefs` (contract §3 "References result", §5 "Reference listing" and "Reference result", §7 "Shared listing" and "Held history steps").

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REF_RESULT_BYTES } from "../../src/contracts/envelope";
import * as LIMITS from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureEnv, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF33, F33_BROKEN_REF, F33_BYTE_TAGS, F33_LIMIT_TAGS, type Built, type F33Variant } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, once, openService, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/refs.ts", import.meta.dir);
printOrigin("../../src/git-service/refs-parser.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const TASK = "T356";
const TIMEOUT_MS = 180_000;
const WAIT_MS = 30_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// Contract §3 "References result": the exact argument array.
const FORMAT = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD)";
const CONTRACT_ARGS = ["--no-lazy-fetch", "--no-optional-locks", "for-each-ref", FORMAT, "refs/heads", "refs/remotes", "refs/tags", "refs/stash"];

interface RefEntry {
  kind: "branch" | "remote" | "tag" | "stash";
  name: string;
  invalidUtf8: boolean;
  objectId: string;
  objectType: string;
  peeledId: string | null;
  peeledType: string | null;
  symref: string | null;
  upstream: string | null;
  upstreamPresent: boolean;
  commitId: string | null;
}

interface RefsResult {
  generation?: number;
  refs?: RefEntry[];
  current?: { name: string; objectId: string } | null;
  refsDigest?: string;
  completeness: { state: string; code?: string; reason?: string };
}

const isForEachRef = (call: { arguments: readonly string[] }) => call.arguments.includes("for-each-ref");
const isConfigList = (call: { arguments: readonly string[] }) => call.arguments.includes("config") && call.arguments.includes("list");

const repoOf = (built: Built) => join(built.root, "clone");
const git = (repo: string, args: string[]) => ownedGit(gitPath(), FIXTURE_ROOT, repo, args);
// Git's own listing with the contract format, in the fixture checkout.
const oracleOutput = (repo: string) => git(repo, CONTRACT_ARGS);

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const fromLatin1 = (text: string) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(text, "latin1"));
const validUtf8 = (text: string) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "latin1"));
    return true;
  } catch {
    return false;
  }
};

// Feature 002 contract Δ3 `readRefs`: Git's records without the records under `refs/stash/`, in Git's output order.
const oracleRecords = (out: Uint8Array) =>
  latin1(out)
    .split("\n")
    .slice(0, -1)
    .map((line) => line.split("\0"))
    .filter((fields) => !fields[0]!.startsWith("refs/stash/"));

// Feature 002 contract Δ3: SHA-256 over `refname NUL objectname LF` of each record.
const oracleDigest = (out: Uint8Array) =>
  createHash("sha256")
    .update(Buffer.from(oracleRecords(out).map(([refname, objectId]) => `${refname}\0${objectId}\n`).join(""), "latin1"))
    .digest("hex");

// Contract §3 "Result fields", applied to Git's own output. The fields are latin1 text, one character per byte.
function oracleEntries(out: Uint8Array): { refs: RefEntry[]; current: { name: string; objectId: string } | null } {
  const records = oracleRecords(out);
  for (const fields of records) expect(fields).toHaveLength(8);
  const names = new Set(records.map((f) => f[0]!));
  const KINDS: [string, RefEntry["kind"]][] = [["refs/heads/", "branch"], ["refs/remotes/", "remote"], ["refs/tags/", "tag"]];
  let current: { name: string; objectId: string } | null = null;
  const refs = records.map(([refname, objectId, objectType, peeledId, peeledType, symref, upstream, head]) => {
    const [prefix, kind] = refname === "refs/stash" ? ["refs/", "stash" as const] : KINDS.find(([p]) => refname!.startsWith(p))!;
    const name = fromLatin1(refname!.slice(prefix.length));
    if (head === "*") current = { name, objectId: objectId! };
    const empty = (value: string) => (value === "" ? null : fromLatin1(value));
    return {
      kind,
      name,
      invalidUtf8: !validUtf8(refname!),
      objectId: objectId!,
      objectType: objectType!,
      peeledId: empty(peeledId!),
      peeledType: empty(peeledType!),
      symref: empty(symref!),
      upstream: empty(upstream!),
      upstreamPresent: upstream !== "" && names.has(upstream!),
      commitId: objectType === "commit" ? objectId! : peeledType === "commit" ? peeledId! : null,
    };
  });
  return { refs, current };
}

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

async function approve(service: Service, repositoryId: string): Promise<void> {
  const trust = await service.readTrust(repositoryId);
  expect(trust.state).toBe("succeeded");
  expect((await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation)).state).toBe("succeeded");
}

const readRefs = (service: Service, repositoryId: string, generation: number) => service.request<RefsResult>("readRefs", {}, { repositoryId, repositoryGeneration: generation });

// Registers the F33 copy and approves its read trust. The R2 canaries make the read gate refuse without approval.
async function opened(service: Service, name: string, variant: F33Variant): Promise<{ built: Built; repo: string; repositoryId: string; generation: number }> {
  const built = buildF33(gitPath(), name, variant);
  const repo = repoOf(built);
  const { repositoryId, generation } = await service.register(repo);
  await approve(service, repositoryId);
  return { built, repo, repositoryId, generation };
}

const canaryLines = (built: Built) =>
  Object.values(built.facts.canaries)
    .map((log) => join(built.root, log))
    .filter((log) => existsSync(log))
    .map((log) => `${log}: ${readFileSync(log, "utf8")}`);

async function waitFor(what: string, found: () => boolean): Promise<void> {
  const until = performance.now() + WAIT_MS;
  while (!found()) {
    if (performance.now() > until) throw new Error(`${what}: not seen within ${WAIT_MS} ms`);
    await Bun.sleep(10);
  }
}

const outcome = (r: ServiceResponse) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };

describe("F33 references (contract §3 \"References result\")", () => {
  caseTest(
    TASK,
    "F33 base: readRefs runs exactly the contract argument array once beside its own trust listing, and the entries equal git for-each-ref",
    ["shell-double"],
    () =>
      withService("t356-base", async (service) => {
        const { built, repo, repositoryId, generation } = await opened(service, "t356-base", "base");
        const first = service.runner.calls.length;
        const response = await readRefs(service, repositoryId, generation);
        expect(outcome(response)).toEqual(SUCCEEDED);
        const ran = service.runner.calls.slice(first).filter((c) => c.refused === undefined);
        // Contract §7 "Hook registrations": the own listing is `config list` and `rev-parse --git-path hooks`.
        expect(ran.filter(isForEachRef).map((c) => c.arguments)).toEqual([CONTRACT_ARGS]);
        expect(ran.length).toBe(3);
        expect(ran.filter(isConfigList).length).toBe(1);
        const result = response.result!;
        expect(result.generation).toBe(generation);
        expect(result.completeness).toEqual({ state: "complete" });
        expect({ refs: result.refs, current: result.current }).toEqual(oracleEntries(oracleOutput(repo)));
        expect(result.refsDigest).toBe(oracleDigest(oracleOutput(repo)));
        expect(canaryLines(built)).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F33 base: each field rule holds for the branches, the remote-tracking branches, and the tags",
    ["shell-double"],
    () =>
      withService("t356-fields", async (service) => {
        const { built, repo, repositoryId, generation } = await opened(service, "t356-fields", "base");
        const { first, second } = built.facts.notes.commits as { first: string; second: string };
        const result = (await readRefs(service, repositoryId, generation)).result!;
        const entry = (kind: RefEntry["kind"], name: string) => result.refs!.find((r) => r.kind === kind && r.name === name);
        const tagOid = (name: string) => git(repo, ["rev-parse", `refs/tags/${name}`]).toString().trim();
        const tree = git(repo, ["rev-parse", `${second}^{tree}`]).toString().trim();
        expect(result.current).toEqual({ name: "main", objectId: second });
        expect(entry("branch", "main")).toMatchObject({ objectType: "commit", commitId: second, upstream: "refs/remotes/origin/main", upstreamPresent: true, symref: null, peeledId: null, peeledType: null });
        expect(entry("branch", "feature/a/b")).toMatchObject({ commitId: second, upstream: null, upstreamPresent: false });
        // `%(upstream)` names a configured upstream that does not exist.
        expect(entry("branch", "gone")).toMatchObject({ commitId: second, upstream: "refs/remotes/origin/gone", upstreamPresent: false });
        expect(entry("branch", "café")).toMatchObject({ invalidUtf8: false, commitId: second });
        expect(entry("remote", "origin/HEAD")).toMatchObject({ symref: "refs/remotes/origin/main", commitId: second });
        expect(entry("remote", "origin/other")).toMatchObject({ commitId: first, upstream: null });
        expect(entry("tag", "light")).toMatchObject({ objectType: "commit", objectId: second, commitId: second, peeledId: null });
        expect(entry("tag", "ann")).toMatchObject({ objectType: "tag", objectId: tagOid("ann"), peeledId: first, peeledType: "commit", commitId: first });
        // The tag of an annotated tag peels to its commit (contract §3 "Output rules").
        expect(entry("tag", "nested")).toMatchObject({ objectType: "tag", objectId: tagOid("nested"), peeledId: first, peeledType: "commit", commitId: first });
        expect(entry("tag", "treetag")).toMatchObject({ objectType: "tag", peeledId: tree, peeledType: "tree", commitId: null });
        // The loose ref file with a broken name gives no entry.
        expect(result.refs!.filter((r) => r.name.includes(".."))).toEqual([]);
        // Git sorts the records by `refname` (git-for-each-ref(1)).
        const full = result.refs!.map((r) => `${{ branch: "refs/heads/", remote: "refs/remotes/", tag: "refs/tags/", stash: "refs/" }[r.kind]}${r.name}`);
        expect(full).toEqual(full.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
      }),
    TIMEOUT_MS,
  );

  for (const variant of ["detached", "unborn"] as const) {
    caseTest(
      TASK,
      `F33 ${variant}: current is null, and the entries equal git for-each-ref`,
      ["shell-double"],
      () =>
        withService(`t356-${variant}`, async (service) => {
          const { repo, repositoryId, generation } = await opened(service, `t356-${variant}`, variant);
          const response = await readRefs(service, repositoryId, generation);
          expect(outcome(response)).toEqual(SUCCEEDED);
          expect(response.result!.current).toBeNull();
          expect({ refs: response.result!.refs, current: response.result!.current }).toEqual(oracleEntries(oracleOutput(repo)));
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "F33 reftable: the reftable copy gives the same entries as the files copy",
    ["shell-double"],
    () =>
      withService("t356-reftable", async (service) => {
        // A new registration can release the previous workspace, so each copy is read right after its registration.
        const files = await opened(service, "t356-reftable-files", "base");
        const filesResponse = await readRefs(service, files.repositoryId, files.generation);
        expect(outcome(filesResponse)).toEqual(SUCCEEDED);
        const a = filesResponse.result!;
        const reftable = await opened(service, "t356-reftable", "reftable");
        expect(git(reftable.repo, ["rev-parse", "--show-ref-format"]).toString().trim()).toBe("reftable");
        const b = await readRefs(service, reftable.repositoryId, reftable.generation);
        expect(outcome(b)).toEqual(SUCCEEDED);
        expect({ refs: b.result!.refs, current: b.result!.current }).toEqual({ refs: a.refs, current: a.current });
      }),
    TIMEOUT_MS,
  );
});

describe("feature 002 readRefs (contract Δ3 `readRefs`)", () => {
  caseTest(
    "T027",
    "refs/stash gives kind stash, a record under refs/stash/ is skipped, and refsDigest covers the other records in Git order",
    ["shell-double"],
    () =>
      withService("t027-stash", async (service) => {
        const { built, repo, repositoryId, generation } = await opened(service, "t027-stash", "base");
        const { first, second } = built.facts.notes.commits as { first: string; second: string };
        // The F33 canary hooks refuse every reference transaction, so the setup runs without hooks.
        const updateRef = (...args: string[]) => git(repo, ["-c", `core.hooksPath=${join(built.root, "no-hooks")}`, "update-ref", ...args]);
        const read = async () => {
          const response = await readRefs(service, repositoryId, generation);
          expect(outcome(response)).toEqual(SUCCEEDED);
          return response.result!;
        };
        const names = (out: Uint8Array) => latin1(out).split("\n").map((line) => line.split("\0")[0]);
        const before = await read();
        expect(before.refsDigest).toBe(oracleDigest(oracleOutput(repo)));
        // Git refuses `refs/stash` beside a name under `refs/stash/`, so each state has one of them.
        updateRef("refs/stash/extra", first);
        const nested = oracleOutput(repo);
        expect(names(nested)).toContain("refs/stash/extra");
        const skipped = await read();
        expect(skipped.refs!.some((r) => r.kind === "stash" || r.name.includes("extra"))).toBe(false);
        expect({ refs: skipped.refs, current: skipped.current }).toEqual(oracleEntries(nested));
        expect(skipped.refsDigest).toBe(before.refsDigest);
        updateRef("-d", "refs/stash/extra");
        updateRef("refs/stash", second);
        const stashed = oracleOutput(repo);
        expect(names(stashed)).toContain("refs/stash");
        const result = await read();
        expect(result.refs!.filter((r) => r.kind === "stash")).toEqual([
          { kind: "stash", name: "stash", invalidUtf8: false, objectId: second, objectType: "commit", peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: second },
        ]);
        expect({ refs: result.refs, current: result.current }).toEqual(oracleEntries(stashed));
        expect(result.refsDigest).toBe(oracleDigest(stashed));
        expect(result.refsDigest).not.toBe(before.refsDigest);
        updateRef("refs/stash", first);
        expect((await read()).refsDigest).not.toBe(result.refsDigest);
      }),
    TIMEOUT_MS,
  );
});

describe("research probes on the admitted Git (contract §3 \"Output rules\")", () => {
  caseTest(TASK, "OBSERVATION: the tag of an annotated tag peels to its commit", ["shell-double"], async () => {
    const built = buildF33(gitPath(), "t356-probe-peel", "base");
    const repo = repoOf(built);
    const { first } = built.facts.notes.commits as { first: string };
    const out = git(repo, [...CONTRACT_ARGS.slice(0, 4), "refs/tags/nested"]);
    const fields = latin1(out).slice(0, -1).split("\0");
    const inner = git(repo, ["cat-file", "-p", "refs/tags/nested"]).toString().split("\n")[0]!;
    console.log(`OBSERVATION ${TASK}: ${git(repo, ["version"]).toString().trim()}: refs/tags/nested object ${fields[1]} type ${fields[2]}, its target line "${inner}", %(*objectname) ${fields[3]}, %(*objecttype) ${fields[4]}, the commit ${first}`);
    expect(inner).toBe(`object ${git(repo, ["rev-parse", "refs/tags/ann"]).toString().trim()}`);
    expect([fields[3], fields[4]]).toEqual([first, "commit"]);
  }, TIMEOUT_MS);

  caseTest(TASK, "OBSERVATION: a loose ref file whose name breaks git-check-ref-format(1) gives no record", ["shell-double"], async () => {
    const built = buildF33(gitPath(), "t356-probe-broken", "base");
    const repo = repoOf(built);
    expect(existsSync(join(repo, ".git", F33_BROKEN_REF))).toBe(true);
    const check = Bun.spawnSync([gitPath(), "check-ref-format", F33_BROKEN_REF], { env: fixtureEnv(), stdout: "pipe", stderr: "pipe" });
    const proc = Bun.spawnSync([gitPath(), ...CONTRACT_ARGS], { cwd: repo, env: fixtureEnv(), stdout: "pipe", stderr: "pipe" });
    const listed = latin1(proc.stdout).includes(F33_BROKEN_REF);
    console.log(
      `OBSERVATION ${TASK}: ${git(repo, ["version"]).toString().trim()}: check-ref-format ${F33_BROKEN_REF} exit ${check.exitCode}; for-each-ref exit ${proc.exitCode}, record listed ${listed}, stderr ${JSON.stringify(proc.stderr.toString())}`,
    );
    expect(check.exitCode).not.toBe(0);
    expect(proc.exitCode).toBe(0);
    expect(listed).toBe(false);
  }, TIMEOUT_MS);
});

describe("record checks and bounds (contract §3 \"Record checks\", §5)", () => {
  // Each edit breaks one record rule in Git's own output of the F33 base copy. Records are latin1 lines of eight NUL-separated fields.
  type Edit = (records: string[][]) => void;
  const at = (records: string[][], refname: string) => records.find((f) => f[0] === refname)!;
  const BROKEN: [string, Edit | "no-final-lf"][] = [
    ["the output does not end with LF", "no-final-lf"],
    ["a record holds seven fields", (r) => void at(r, "refs/heads/main").pop()],
    ["a record holds nine fields", (r) => void at(r, "refs/heads/main").push("")],
    ["an empty record", (r) => void r.splice(1, 0, [""])],
    ["refname outside refs/heads/, refs/remotes/, and refs/tags/", (r) => void (at(r, "refs/tags/light")[0] = "refs/notes/light")],
    ["refname refs/stashed, outside the refs/stash pattern", (r) => void (at(r, "refs/tags/light")[0] = "refs/stashed")],
    ["objectname in uppercase", (r) => void (at(r, "refs/heads/main")[1] = at(r, "refs/heads/main")[1]!.toUpperCase())],
    ["objectname of another object format", (r) => void (at(r, "refs/heads/main")[1] = "a".repeat(64))],
    ["an unknown objecttype", (r) => void (at(r, "refs/heads/main")[2] = "bogus")],
    ["a tag without *objectname", (r) => void (at(r, "refs/tags/ann")[3] = "")],
    ["a tag whose *objecttype is tag", (r) => void (at(r, "refs/tags/nested")[4] = "tag")],
    [
      "a commit with *objectname and *objecttype",
      (r) => {
        const light = at(r, "refs/tags/light");
        light[3] = light[1]!;
        light[4] = "commit";
      },
    ],
    ["symref outside refs/", (r) => void (at(r, "refs/remotes/origin/HEAD")[5] = "origin/main")],
    ["upstream outside refs/", (r) => void (at(r, "refs/heads/main")[6] = "origin/main")],
    ["HEAD neither * nor one space", (r) => void (at(r, "refs/heads/gone")[7] = "x")],
    ["two * records", (r) => void (at(r, "refs/heads/gone")[7] = "*")],
    [
      "* on a tag record",
      (r) => {
        at(r, "refs/heads/main")[7] = " ";
        at(r, "refs/tags/light")[7] = "*";
      },
    ],
  ];

  caseTest(
    TASK,
    "each broken record rule gives failed with MALFORMED_GIT_OUTPUT and no records",
    ["shell-double"],
    () =>
      withService("t356-malformed", async (service) => {
        const { repo, repositoryId, generation } = await opened(service, "t356-malformed", "base");
        const real = latin1(oracleOutput(repo));
        // Control: the unchanged output passes every record check.
        service.runner.inject.stdout = (call) => (isForEachRef(call) ? Buffer.from(real, "latin1") : undefined);
        expect(outcome(await readRefs(service, repositoryId, generation))).toEqual(SUCCEEDED);
        const results: Record<string, unknown> = {};
        for (const [name, edit] of BROKEN) {
          let text: string;
          if (edit === "no-final-lf") text = real.slice(0, -1);
          else {
            const records = real.slice(0, -1).split("\n").map((line) => line.split("\0"));
            edit(records);
            text = `${records.map((f) => f.join("\0")).join("\n")}\n`;
          }
          service.runner.inject.stdout = (call) => (isForEachRef(call) ? Buffer.from(text, "latin1") : undefined);
          const response = await readRefs(service, repositoryId, generation);
          results[name] = { ...outcome(response), result: response.result };
        }
        service.runner.inject.stdout = undefined;
        const expected = { state: "failed", code: "MALFORMED_GIT_OUTPUT", result: { completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } } };
        expect(results).toEqual(Object.fromEntries(BROKEN.map(([name]) => [name, expected])));
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a nonzero for-each-ref exit gives failed with GIT_FAILED and no records",
    ["shell-double"],
    () =>
      withService("t356-git-failed", async (service) => {
        const { repositoryId, generation } = await opened(service, "t356-git-failed", "base");
        service.runner.inject.exit = (call) => (isForEachRef(call) ? 128 : undefined);
        const response = await readRefs(service, repositoryId, generation);
        service.runner.inject.exit = undefined;
        expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "GIT_FAILED", result: { completeness: { state: "failed", code: "GIT_FAILED" } } });
      }),
    TIMEOUT_MS,
  );

  const LIMIT_CASES: [F33Variant, "REF_LISTING_RECORDS" | "REF_LISTING_BYTES"][] = [
    ["limit-records", "REF_LISTING_RECORDS"],
    ["limit-bytes", "REF_LISTING_BYTES"],
  ];
  for (const [variant, reason] of LIMIT_CASES) {
    caseTest(
      TASK,
      `F33 ${variant}: the Git output passes its bound, and the read ends limited with OUTPUT_LIMIT, reason ${reason}, and no records`,
      ["shell-double"],
      () =>
        withService(`t356-${variant}`, async (service) => {
          const { repo, repositoryId, generation } = await opened(service, `t356-${variant}`, variant);
          const out = oracleOutput(repo);
          const records = latin1(out).split("\n").length - 1;
          if (variant === "limit-records") expect(records).toBeGreaterThan(LIMITS.REF_LISTING_RECORDS);
          else expect({ records: records <= LIMITS.REF_LISTING_RECORDS, bytes: out.length > LIMITS.REF_LISTING_BYTES }).toEqual({ records: true, bytes: true });
          const response = await readRefs(service, repositoryId, generation);
          expect({ ...outcome(response), result: response.result }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } } });
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    `exactly ${LIMITS.REF_LISTING_RECORDS} records give a complete result`,
    ["shell-double"],
    () =>
      withService("t356-records-at-limit", async (service) => {
        const { repo, repositoryId, generation } = await opened(service, "t356-records-at-limit", "limit-at-bound");
        expect(latin1(oracleOutput(repo)).split("\n").length - 1).toBe(LIMITS.REF_LISTING_RECORDS);
        const response = await readRefs(service, repositoryId, generation);
        expect(outcome(response)).toEqual(SUCCEEDED);
        expect(response.result!.refs).toHaveLength(LIMITS.REF_LISTING_RECORDS);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `an encoded result above ${REF_RESULT_BYTES} bytes gives limited with reason REF_LISTING_BYTES and no records`,
    ["shell-double"],
    () =>
      withService("t356-result-bytes", async (service) => {
        const { repo, repositoryId, generation } = await opened(service, "t356-result-bytes", "base");
        const oid = git(repo, ["rev-parse", "HEAD"]).toString().trim();
        // Each 0xFF byte decodes to U+FFFD, three UTF-8 bytes in the result. So the Git output stays below its bound, and the encoded result passes its bound.
        const name = "\xff".repeat(440);
        const count = 8_000;
        const text = Array.from({ length: count }, (_, i) => `refs/tags/${name}${String(i).padStart(5, "0")}\0${oid}\0commit\0\0\0\0\0 \n`).join("");
        const bytes = Buffer.from(text, "latin1");
        expect(bytes.length).toBeLessThanOrEqual(LIMITS.REF_LISTING_BYTES);
        expect(count * 440 * 3).toBeGreaterThan(REF_RESULT_BYTES);
        service.runner.inject.stdout = (call) => (isForEachRef(call) ? bytes : undefined);
        const response = await readRefs(service, repositoryId, generation);
        service.runner.inject.stdout = undefined;
        expect({ ...outcome(response), result: response.result }).toEqual({
          state: "limited",
          code: "OUTPUT_LIMIT",
          result: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "REF_LISTING_BYTES" } },
        });
      }),
    TIMEOUT_MS,
  );

  test("the limit copies use the contract §5 bounds", () => {
    expect({ records: LIMITS.REF_LISTING_RECORDS, bytes: LIMITS.REF_LISTING_BYTES, result: REF_RESULT_BYTES }).toEqual({ records: 10_000, bytes: 4 * 1024 * 1024, result: 8 * 1024 * 1024 });
    expect(F33_LIMIT_TAGS).toBeGreaterThan(LIMITS.REF_LISTING_RECORDS);
    expect(F33_BYTE_TAGS).toBeLessThan(LIMITS.REF_LISTING_RECORDS);
  });
});

describe("trust gate, held step, and scheduling (contract §5 \"Pending reads\", §7)", () => {
  caseTest(
    TASK,
    "an F33 copy without read approval gives TRUST_REQUIRED, the refused gate ends the held for-each-ref, no response holds a reference, and no R2 canary runs before or after approval",
    ["shell-double"],
    () =>
      withService("t356-trust", async (service) => {
        const built = buildF33(gitPath(), "t356-trust", "base");
        const repo = repoOf(built);
        const real = oracleOutput(repo);
        const { repositoryId, generation } = await service.register(repo);
        // The double sends the real bytes, and the stdout barrier holds them. So only the refused gate can end for-each-ref.
        service.runner.inject.stdout = (call) => (isForEachRef(call) ? real : undefined);
        const releaseListing = service.runner.pauseStdout(once(isConfigList));
        const releaseRefs = service.runner.pauseStdout(once(isForEachRef));
        try {
          const request = service.send("readRefs", {}, { repositoryId, repositoryGeneration: generation });
          await waitFor("for-each-ref call", () => service.runner.calls.some(isForEachRef));
          releaseListing();
          const response = await service.response<RefsResult>(request);
          expect({ code: response.code, succeeded: response.state === "succeeded", refs: response.result?.refs }).toEqual({ code: "TRUST_REQUIRED", succeeded: false, refs: undefined });
          expect(service.runner.calls.filter(isForEachRef).map((c) => c.exit?.exitCode)).toEqual([null]);
        } finally {
          releaseListing();
          releaseRefs();
          service.runner.inject.stdout = undefined;
        }
        const text = JSON.stringify(service.responses);
        expect(["refs/remotes/origin/HEAD", "treetag", "feature/a/b"].filter((name) => text.includes(name))).toEqual([]);
        expect(canaryLines(built)).toEqual([]);
        await approve(service, repositoryId);
        expect(outcome(await readRefs(service, repositoryId, generation))).toEqual(SUCCEEDED);
        expect(canaryLines(built)).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "readRefs waits for the read gate: an ended for-each-ref gives no response while the trust listing runs",
    ["shell-double"],
    () =>
      withService("t356-gate-wait", async (service) => {
        const { repositoryId, generation } = await opened(service, "t356-gate-wait", "base");
        const releaseListing = service.runner.pauseStdout(once(isConfigList));
        try {
          const request = service.send("readRefs", {}, { repositoryId, repositoryGeneration: generation });
          await waitFor("for-each-ref exit", () => service.runner.calls.some((c) => isForEachRef(c) && c.exit !== undefined));
          expect(service.responses.filter((r) => r.requestId === request)).toEqual([]);
          releaseListing();
          expect(outcome(await service.response(request))).toEqual(SUCCEEDED);
        } finally {
          releaseListing();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a second readRefs cancels the unfinished first one as superseded",
    ["shell-double"],
    () =>
      withService("t356-superseded", async (service) => {
        const { repositoryId, generation } = await opened(service, "t356-superseded", "base");
        const releaseListing = service.runner.pauseStdout(once(isConfigList));
        try {
          const older = service.send("readRefs", {}, { repositoryId, repositoryGeneration: generation });
          const olderId = await service.operationId(older);
          await waitFor("held listing of the first readRefs", () => service.runner.calls.some((c) => c.operationId === olderId && isConfigList(c)));
          const newer = await readRefs(service, repositoryId, generation);
          expect(outcome(newer)).toEqual(SUCCEEDED);
          expect(outcome(await service.response(older))).toEqual({ state: "canceled", code: "CANCELED" });
        } finally {
          releaseListing();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a readRefs with another repositoryGeneration gives REPOSITORY_CHANGED and starts no Git process",
    ["shell-double"],
    () =>
      withService("t356-generation", async (service) => {
        const { repositoryId, generation } = await opened(service, "t356-generation", "base");
        const before = service.runner.calls.length;
        const response = await readRefs(service, repositoryId, generation + 1);
        expect(outcome(response)).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED" });
        expect(service.runner.calls.length).toBe(before);
      }),
    TIMEOUT_MS,
  );
});
