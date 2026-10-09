// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T113: the HEAD log attribution window and its bounds (contract §5 "Commit attribution evidence", §8 "Commit attribution read" and "Attribution window").
// The pure cases run no Git process. The last describe block reads the HEAD log of a real repository through the shell double.

import { describe, expect, test } from "bun:test";
import { ATTRIBUTION_EVIDENCE_BYTES, ATTRIBUTION_EVIDENCE_RECORDS } from "../../src/contracts/limits";
import { attribute, readTip, readWindow, windowOf, type ReflogRecord, type Window } from "../../src/git-service/attribution";
import { probeGit } from "../../src/git-service/git-installation";
import type { GitCall, GitExit, GitRunner } from "../../src/git-service/git-runner";
import type { ObserveContext } from "../../src/git-service/hunk-publish";
import { createRegistrations } from "../../src/git-service/registration";
import type { Head } from "../../src/git-service/snapshot";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF20, inflateHeadReflog } from "./fixtures";
import { git, gitPath, gitText, repoOf, TIMEOUT_MS, withService } from "./hunk-harness";
import { caseTest, type Service } from "./service-harness";

printOrigin("../../src/git-service/attribution.ts", import.meta.dir);

const [A, B, C, D] = ["a", "b", "c", "d"].map((c) => c.repeat(40)) as [string, string, string, string];
// Contract §8: the read argv. The tip read adds `-n 1` after `log`.
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "log", "-g", "-z", "--date=raw", "--no-show-signature", "--no-decorate", "--no-color", "--format=%H%x00%gd%x00%gn%x00%ge%x00%gs", "HEAD", "--"];
const TIP_READ = [...READ.slice(0, 4), "-n", "1", ...READ.slice(4)];

type Fields = { oid: string; selector: string; name: string; email: string; message: string };
const FIELDS: Fields = { oid: A, selector: "HEAD@{1791580480 +0300}", name: "Arbareto Fixture", email: "fixture@arbareto.invalid", message: "commit: tip" };
// One record in the contract §8 form: five fields, each ending with NUL.
const bytesOf = (f: Partial<Fields> = {}) => Buffer.from(Object.values({ ...FIELDS, ...f }).map((v) => `${v}\0`).join(""));
const TIP: ReflogRecord = { oid: A, raw: bytesOf() };
const other = (oid: string, n: number) => bytesOf({ oid, selector: `HEAD@{${1791580480 + n} +0300}`, message: `commit: ${n}` });
const many = (count: number) => Buffer.concat(Array.from({ length: count }, (_, i) => other(B, i + 1)));
const oids = (w: Window | null) => (w !== null && "records" in w ? w.records.map((r) => r.oid) : w);

// A record of exactly `bytes` bytes. The message fills the rest.
const sized = (bytes: number) => bytesOf({ oid: B, message: "m".repeat(bytes - bytesOf({ oid: B, message: "" }).length) });

describe("windowOf (contract §8 \"Attribution window\")", () => {
  test("a record with a Unicode subject keeps its exact bytes and its full OID", () => {
    const raw = bytesOf({ oid: B, message: "commit: Привіт ✓ 你好 🌳" });
    expect(windowOf(raw, null, false, "sha1")).toEqual({ records: [{ oid: B, raw }] });
    expect(windowOf(bytesOf({ oid: "b".repeat(64) }), null, false, "sha256")).toEqual({ records: [{ oid: "b".repeat(64), raw: bytesOf({ oid: "b".repeat(64) }) }] });
  });

  test.each([
    ["an abbreviated OID", bytesOf({ oid: "a".repeat(39) })],
    ["an OID of the other object format", bytesOf({ oid: "a".repeat(64) })],
    ["an index selector", bytesOf({ selector: "HEAD@{0}" })],
    ["a log that ends inside a record", bytesOf().subarray(0, -1)],
  ])("%s breaks the form", (_name, bytes) => {
    expect(windowOf(bytes, null, false, "sha1")).toBeNull();
  });

  test("the tip ends the window; older records stay out", () => {
    expect(oids(windowOf(Buffer.concat([other(D, 3), other(C, 2), TIP.raw, other(B, 1)]), TIP, false, "sha1"))).toEqual([D, C]);
    expect(oids(windowOf(Buffer.concat([TIP.raw, other(B, 1)]), TIP, false, "sha1"))).toEqual([]);
  });

  // Contract §8: a record equals the tip only in all five printed fields.
  test.each([
    ["commit OID", { oid: B }],
    ["selector", { selector: "HEAD@{1791580481 +0300}" }],
    ["committer name", { name: "Other" }],
    ["committer email", { email: "other@arbareto.invalid" }],
    ["message", { message: "commit: other" }],
  ] as const)("a tip absent at the log end gives every record; a record that differs only in its %s is no tip", (_field, change) => {
    const log = Buffer.concat([other(C, 2), bytesOf(change)]);
    const expected = [C, "oid" in change ? change.oid : A];
    expect(oids(windowOf(log, TIP, false, "sha1"))).toEqual(expected);
    expect(oids(windowOf(log, null, false, "sha1"))).toEqual(expected);
  });

  test("a capped read without the tip gives evidence-limit", () => {
    expect(windowOf(other(B, 1), TIP, true, "sha1")).toEqual({ evidenceLimit: true });
    expect(windowOf(other(B, 1), null, true, "sha1")).toEqual({ evidenceLimit: true });
  });
});

// A runner double that streams `bytes` in 64 KiB chunks. It stops at a limited collector, as the shell cancels the process (native-runner.ts).
function streaming(bytes: Uint8Array, exitCode: number | null = 0) {
  const calls: string[][] = [];
  let pushed = 0;
  const runner = {
    async run(call: GitCall): Promise<GitExit> {
      calls.push([...call.arguments]);
      for (let at = 0; at < bytes.length; at += 65_536) {
        call.stdout.push(bytes.subarray(at, at + 65_536));
        pushed = Math.min(bytes.length, at + 65_536);
        if (call.stdout.limited) return { exitCode: null, activeDescendants: 0 };
      }
      return { exitCode, activeDescendants: 0 };
    },
  } as unknown as GitRunner;
  // `readTip` and `readWindow` use only the runner, the operation, the signal, and the workspace.
  const workspace = { objectFormat: "sha1", gitInstallationId: crypto.randomUUID(), repositoryId: crypto.randomUUID() };
  const ctx = { runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace } as unknown as ObserveContext;
  return { ctx, calls, pushed: () => pushed };
}

// The record count of the window, or the window or failure without records.
const counted = async (bytes: Uint8Array, tip: ReflogRecord | null) => {
  const s = streaming(bytes);
  const read = await readWindow(s.ctx, tip);
  expect(s.calls).toEqual([READ]);
  return "value" in read && "records" in read.value ? read.value.records.length : "value" in read ? read.value : read;
};
const plain = (r: ReflogRecord) => ({ oid: r.oid, raw: Buffer.from(r.raw) });

describe("readWindow bounds (contract §5 \"Commit attribution evidence\")", () => {
  // The tip counts toward the 10,000 records.
  test(`${ATTRIBUTION_EVIDENCE_RECORDS} records are accepted, and ${ATTRIBUTION_EVIDENCE_RECORDS + 1} give evidence-limit`, async () => {
    expect(await counted(Buffer.concat([many(ATTRIBUTION_EVIDENCE_RECORDS - 1), TIP.raw]), TIP)).toBe(ATTRIBUTION_EVIDENCE_RECORDS - 1);
    expect(await counted(Buffer.concat([many(ATTRIBUTION_EVIDENCE_RECORDS), TIP.raw]), TIP)).toEqual({ evidenceLimit: true });
    expect(await counted(many(ATTRIBUTION_EVIDENCE_RECORDS), null)).toBe(ATTRIBUTION_EVIDENCE_RECORDS);
    expect(await counted(many(ATTRIBUTION_EVIDENCE_RECORDS + 1), null)).toEqual({ evidenceLimit: true });
    expect(await counted(many(ATTRIBUTION_EVIDENCE_RECORDS + 2), TIP)).toEqual({ evidenceLimit: true });
  });

  test("4 MiB are accepted, and 4 MiB + 1 byte gives evidence-limit", async () => {
    const before = ATTRIBUTION_EVIDENCE_BYTES - TIP.raw.length;
    expect(await counted(Buffer.concat([sized(before), TIP.raw]), TIP)).toBe(1);
    expect(await counted(Buffer.concat([sized(before + 1), TIP.raw]), TIP)).toEqual({ evidenceLimit: true });
    expect(await counted(sized(ATTRIBUTION_EVIDENCE_BYTES), null)).toBe(1);
    expect(await counted(sized(ATTRIBUTION_EVIDENCE_BYTES + 1), null)).toEqual({ evidenceLimit: true });
  });

  test("the read stops after the tip record, and the exit status of the canceled read decides nothing", async () => {
    const s = streaming(Buffer.concat([other(C, 2), TIP.raw, many(40_000)]), 128);
    const read = await readWindow(s.ctx, TIP);
    expect("value" in read && "records" in read.value ? read.value.records.map(plain) : read).toEqual([{ oid: C, raw: other(C, 2) }]);
    expect(s.pushed()).toBe(65_536);
  });

  test("a read that ends inside the caps needs exit 0", async () => {
    expect(await readWindow(streaming(other(B, 1), 128).ctx, TIP)).toEqual({ code: "GIT_FAILED" });
    expect(await readWindow(streaming(bytesOf({ selector: "HEAD@{0}" })).ctx, null)).toEqual({ code: "MALFORMED_GIT_OUTPUT" });
  });
});

describe("readTip (contract §9 commit preflight)", () => {
  const head: Head = { state: "branch", target: "refs/heads/main", oid: A };

  test("the newest record is the tip; the tip read has `-n 1` after `log`", async () => {
    const s = streaming(TIP.raw);
    const tip = await readTip(s.ctx, head);
    expect("value" in tip && tip.value !== null ? plain(tip.value) : tip).toEqual(plain(TIP));
    expect(s.calls).toEqual([TIP_READ]);
  });

  test("an unborn reviewed HEAD gets no read, and an empty log with exit 0 gives no tip", async () => {
    const unborn = streaming(TIP.raw);
    expect(await readTip(unborn.ctx, { state: "unborn", target: "refs/heads/main" })).toEqual({ value: null });
    expect(unborn.calls).toEqual([]);
    expect(await readTip(streaming(new Uint8Array(0)).ctx, head)).toEqual({ value: null });
  });

  test.each([
    ["exit 128", streaming(new Uint8Array(0), 128), { code: "GIT_FAILED" }],
    ["two records", streaming(Buffer.concat([TIP.raw, other(B, 1)])), { code: "MALFORMED_GIT_OUTPUT" }],
    ["a tip record above 4 MiB", streaming(sized(ATTRIBUTION_EVIDENCE_BYTES + 1)), { code: "OUTPUT_LIMIT", reason: "ATTRIBUTION_EVIDENCE_BYTES" }],
  ] as const)("%s fails the tip read", async (_name, s, failure) => {
    expect(await readTip(s.ctx, head)).toEqual(failure);
  });
});

describe("attribute (contract §8 \"Attribution window\")", () => {
  const h0: Head = { state: "branch", target: "refs/heads/main", oid: A };
  const h1: Head = { ...h0, oid: B };
  const unborn: Head = { state: "unborn", target: "refs/heads/main" };
  const records = (...list: string[]): Window => ({ records: list.map((oid, i) => ({ oid, raw: other(oid, i) })) });

  test.each([
    ["one record of the observed HEAD whose parent is the reviewed HEAD", records(B), h0, h1, [A], { identified: B }],
    ["one root commit after an unborn reviewed HEAD", records(B), unborn, h1, [], { identified: B }],
    ["one record whose commit is not the observed HEAD", records(C), h0, h1, [A], { unknown: "ambiguous" }],
    ["one record with wrong parents", records(B), h0, h1, [C], { unknown: "ambiguous" }],
    ["one record with an extra parent", records(B), h0, h1, [A, C], { unknown: "ambiguous" }],
    ["one record with no parent after a born reviewed HEAD", records(B), h0, h1, [], { unknown: "ambiguous" }],
    ["one record without read parents", records(B), h0, h1, null, { unknown: "ambiguous" }],
    ["no record and an unchanged HEAD", records(), h0, h0, null, { none: true }],
    ["no record and an unborn HEAD that stays unborn", records(), unborn, unborn, null, { none: true }],
    ["no record and a moved HEAD", records(), h0, h1, null, { unknown: "ambiguous" }],
    ["no record and a born HEAD after an unborn reviewed HEAD", records(), unborn, h1, null, { unknown: "ambiguous" }],
    ["evidence above a cap", { evidenceLimit: true } as Window, h0, h1, [A], { unknown: "evidence-limit" }],
  ] as const)("%s", (_name, w, from, to, parents, result) => {
    expect(attribute(w, from, to, parents)).toEqual(result);
  });

  // The newer record alone would identify the commit. A second record makes the window ambiguous.
  test("two records after the tip give ambiguous", () => {
    const w = windowOf(Buffer.concat([other(B, 2), other(C, 1), TIP.raw]), TIP, false, "sha1")!;
    expect(oids(w)).toEqual([B, C]);
    expect(attribute(w, h0, h1, [A])).toEqual({ unknown: "ambiguous" });
  });
});

describe("the HEAD log of a real repository (contract §8)", () => {
  useFixtureRoot();

  // The Git-resolved workspace of `repo` in the shell double, and an attribution context on it.
  async function attributionContext(service: Service, repo: string): Promise<ObserveContext> {
    const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
    if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
    const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
    const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation: probed.installation, signal: new AbortController().signal });
    if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
    const workspace = registrations.get(registered.result.repositoryId)!;
    return { runner: service.runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace } as unknown as ObserveContext;
  }
  const headOf = (repo: string) => ({ state: "branch" as const, target: "refs/heads/main", oid: gitText(repo, ["rev-parse", "HEAD"]).trim() });

  caseTest("T113", "F20 files: one commit after the tip gives a window of one record, and that record identifies the commit", ["shell-double"], () =>
    withService({ name: "t113-window" }, async (service) => {
      const repo = repoOf(buildF20(gitPath(), "t113-window", "base"));
      const ctx = await attributionContext(service, repo);
      const h0 = headOf(repo);
      const tip = await readTip(ctx, h0);
      if (!("value" in tip) || tip.value === null) throw new Error(`no tip: ${JSON.stringify(tip)}`);
      expect(tip.value.oid).toBe(h0.oid);
      git(repo, ["commit", "-q", "--no-verify", "-m", "after the tip"]);
      const h1 = headOf(repo);
      const read = await readWindow(ctx, tip.value);
      if (!("value" in read)) throw new Error(`no window: ${JSON.stringify(read)}`);
      expect(oids(read.value)).toEqual([h1.oid]);
      const parents = gitText(repo, ["show", "-s", "--format=%P", "HEAD"]).trim().split(" ");
      expect(attribute(read.value, h0, h1, parents)).toEqual({ identified: h1.oid });
    }),
    TIMEOUT_MS,
  );

  caseTest("T113", "F20 files: inflateHeadReflog after the tip gives evidence-limit for reflog-records and for reflog-bytes", ["shell-double"], () =>
    withService({ name: "t113-inflated" }, async (service) => {
      for (const variant of ["reflog-records", "reflog-bytes"] as const) {
        const repo = repoOf(buildF20(gitPath(), `t113-${variant}`, variant));
        const ctx = await attributionContext(service, repo);
        const tip = await readTip(ctx, headOf(repo));
        if (!("value" in tip)) throw new Error(`no tip: ${JSON.stringify(tip)}`);
        inflateHeadReflog(repo, variant, "files");
        expect({ variant, read: await readWindow(ctx, tip.value) }).toEqual({ variant, read: { value: { evidenceLimit: true } } });
      }
    }),
    TIMEOUT_MS,
  );
});
