// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T104 stage 1: the reply and the retained listing of `readCommitChanges` against the v0.1.2 parse and reply (feature 005 contract Δ3, Δ5, Δ8).
// `parseRawListing` is the v0.1.2 parse. `v012` below is the v0.1.2 reply block. The service reads through a runner double that sends fixed bytes.

import { describe, expect, test } from "bun:test";
import { COMMIT_CHANGES_RESULT_BYTES, NATIVE_CHUNK_BYTES, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { commitChangesArgs, type ObjectFormat } from "../../src/git-service/commands";
import { b64, createCommitChanges, parseRawListing, rawListingOffsets, type Listing, type RawEntry } from "../../src/git-service/commit-changes";
import type { Collector, GitExit } from "../../src/git-service/git-runner";
import { encodedBytes } from "../../src/git-service/read-steps";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, useFixtureRoot } from "./fixture-root";
import { buildHistory, buildWide, EMPTY_TREE, HISTORY_LABELS, runGit } from "./history-diff-fixtures";
import { rng } from "./history-fixtures";
import { gitPath } from "./history-view-harness";
import { caseTest } from "./service-harness";

printOrigin("../../src/git-service/commit-changes.ts", import.meta.dir);

useFixtureRoot();

const TASK = "T104";
const TIMEOUT_MS = 300_000;
const COMMIT_CUT = "COMMIT_CHANGES_RESULT_BYTES";
const VIEW = "view";
const NUL = Uint8Array.of(0);
const OID_HEX: Record<ObjectFormat, number> = { sha1: 40, sha256: 64 };
const TARGET: Record<ObjectFormat, { base: string; oid: string }> = { sha1: { base: "1".repeat(40), oid: "2".repeat(40) }, sha256: { base: "1".repeat(64), oid: "2".repeat(64) } };
const STATUS_NAMES = { A: "added", D: "deleted", M: "modified", R: "renamed", T: "type-changed" } as const;

const latin = (text: string) => Buffer.from(text, "latin1");
const record = (head: string, ...paths: Uint8Array[]) => Buffer.concat([latin(head), NUL, ...paths.flatMap((p) => [p, NUL])]);
const bytesOf = (view: ArrayBufferView) => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const show = (value: unknown) => JSON.stringify(value, (_key, x: unknown) => (x instanceof Uint8Array ? `bytes:${bytesOf(x).toString("hex")}` : x));

// Valid diff-format(5) raw records: A, D, M, T, and R with each score form, the file, executable, link, and gitlink modes, and any name bytes but NUL.
function seeded(rand: () => number, objectFormat: ObjectFormat, count: number): Buffer {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const hex = () => Array.from({ length: OID_HEX[objectFormat] }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const zero = "0".repeat(OID_HEX[objectFormat]);
  const mode = () => pick(["100644", "100755", "120000", "160000"]);
  const name = () => Uint8Array.from({ length: 1 + Math.floor(rand() * 24) }, () => 1 + Math.floor(rand() * 255));
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const status = pick(["A", "D", "M", "T", "R"] as const);
    const [a, b] = status === "A" ? [["000000", zero], [mode(), hex()]] : status === "D" ? [[mode(), hex()], ["000000", zero]] : [[mode(), hex()], [mode(), hex()]];
    const code = status === "R" ? `R${String(Math.floor(rand() * 101)).padStart(3, "0")}` : status;
    parts.push(record(`:${a[0]} ${b[0]} ${a[1]} ${b[1]} ${code}`, ...(status === "R" ? [name(), name()] : [name()])));
  }
  return Buffer.concat(parts);
}

// One changed, dropped, or inserted byte. Most results break the grammar. Some stay valid.
function damaged(rand: () => number, raw: Buffer): Buffer {
  const at = Math.floor(rand() * raw.length);
  const special = latin(":\0 0R1CAMg");
  const byte = rand() < 0.5 ? Math.floor(rand() * 256) : special[Math.floor(rand() * special.length)]!;
  const kind = Math.floor(rand() * 3);
  return Buffer.concat([raw.subarray(0, at), kind === 1 ? Buffer.alloc(0) : Buffer.from([byte]), raw.subarray(kind === 2 ? at : at + 1)]);
}

// `count` M records whose paths have `size` bytes, and a last path of `last` bytes.
function uniform(count: number, size: number, last = size): Buffer {
  const head = latin(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M`);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) parts.push(head, NUL, Buffer.alloc(i === count - 1 ? last : size, 0x61 + (i % 26)), NUL);
  return Buffer.concat(parts);
}

// The service module with a runner double that sends `raw` in native chunks, and a trust double that allows each read.
function read(raw: Uint8Array, objectFormat: ObjectFormat) {
  const runner = {
    async run(call: { stdout: Collector }): Promise<GitExit> {
      for (let at = 0; at < raw.length && !call.stdout.limited; at += NATIVE_CHUNK_BYTES) call.stdout.push(raw.subarray(at, at + NATIVE_CHUNK_BYTES));
      return { exitCode: 0, activeDescendants: 0 };
    },
  };
  const trust = { listTrust: async () => ({ ok: true, listing: { entries: [] } }), gate: () => null };
  const changes = createCommitChanges({ runner: runner as never, trust: trust as never });
  const { base, oid } = TARGET[objectFormat];
  const t = { operationId: "op", signal: new AbortController().signal, workspace: { repositoryId: "repo", gitInstallationId: "git", objectFormat } as never, installation: {} as never };
  return { changes, outcome: changes.readCommitChanges(t, { viewId: VIEW, oid, parents: [base], shallow: false }, 0) };
}

// The v0.1.2 reply block of `readCommitChanges`, on the v0.1.2 parse. Null: the listing refuses.
function v012(bytes: Uint8Array, objectFormat: ObjectFormat, limited: boolean, value: (files: unknown[], completeness: object) => object) {
  // A plain view, as the collector gives. A Buffer subarray has `toJSON`, which `show` does not see.
  const raw = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = parseRawListing(raw, objectFormat, limited);
  if (parsed === null) return null;
  const entryValue = (e: RawEntry, fileId: number) => ({ fileId, status: STATUS_NAMES[e.status], ...(e.score === undefined ? {} : { score: e.score }), pathBytes: b64(e.path), ...(e.oldPath === undefined ? {} : { oldPathBytes: b64(e.oldPath) }), kind: e.kind });
  let reason: string | null = limited ? "STATUS_LISTING_BYTES" : null;
  let entries = parsed;
  if (entries.length > STATUS_LISTING_RECORDS) {
    entries = entries.slice(0, STATUS_LISTING_RECORDS);
    reason ??= "STATUS_LISTING_RECORDS";
  }
  const files = entries.map(entryValue);
  const fixed = new Map<string, number>();
  const sizeOf = (n: number, r: string | null) => {
    const key = `${r}:${String(n).length}`;
    if (!fixed.has(key)) fixed.set(key, encodedBytes(value([], r === null ? { state: "complete" } : { state: "limited", code: "OUTPUT_LIMIT", reason: r, shown: n })));
    return fixed.get(key)!;
  };
  let total = sizeOf(files.length, reason);
  for (const f of files) total += encodedBytes(f) + 1;
  if (files.length > 0) total -= 1;
  if (total > COMMIT_CHANGES_RESULT_BYTES) {
    let n = 0;
    let sum = 0;
    for (const f of files) {
      const next = sum + encodedBytes(f) + (n === 0 ? 0 : 1);
      if (sizeOf(n + 1, COMMIT_CUT) + next > COMMIT_CHANGES_RESULT_BYTES) break;
      sum = next;
      n++;
    }
    files.length = n;
    entries = entries.slice(0, n);
    reason = COMMIT_CUT;
  }
  const end = entries.at(-1)?.end ?? 0;
  const kept = { raw: raw.subarray(0, end), offsets: Uint32Array.from([...entries.map((e) => e.start), end]) };
  // The v0.1.2 `entryOf` on the retained listing.
  const entry = (i: number) => (i >= kept.offsets.length - 1 ? { refused: "INVALID_REQUEST" } : parseRawListing(kept.raw.subarray(kept.offsets[i]!, kept.offsets[i + 1]!), objectFormat, false)![0]!);
  return { files, reason, kept, entry };
}

interface Reply {
  changesId: string;
  files: unknown[];
  completeness: object;
}

const firstDifference = (n: number, a: (i: number) => unknown, b: (i: number) => unknown) => {
  for (let i = 0; i < n; i++) if (show(a(i)) !== show(b(i))) return i;
  return -1;
};

// One read of `raw`, beside the v0.1.2 reply of the same bytes. The double sends at most STATUS_LISTING_BYTES, as the collector keeps.
async function compared(raw: Uint8Array, objectFormat: ObjectFormat) {
  const { changes, outcome } = read(raw, objectFormat);
  const got = (await outcome) as { result: string; code?: string; value?: Reply };
  const reply = got.value;
  const limited = raw.length > STATUS_LISTING_BYTES;
  const { base, oid } = TARGET[objectFormat];
  const value = (files: unknown[], completeness: object) => ({ changesId: reply?.changesId ?? "", viewId: VIEW, oid, parents: [base], base: { kind: "parent", index: 0, oid: base }, files, completeness });
  const old = v012(limited ? raw.subarray(0, STATUS_LISTING_BYTES) : raw, objectFormat, limited, value);
  const want =
    old === null
      ? { result: "failed", code: "MALFORMED_GIT_OUTPUT", completeness: undefined, shown: undefined }
      : { result: old.reason === null ? "succeeded" : "limited", code: old.reason === null ? undefined : "OUTPUT_LIMIT", completeness: old.reason === null ? { state: "complete" } : { state: "limited", code: "OUTPUT_LIMIT", reason: old.reason, shown: old.files.length }, shown: old.files.length };
  const shown = reply?.files.length ?? 0;
  const entryOf = (i: number) => {
    if (reply === undefined) return null;
    const found = changes.entry(reply.changesId, i);
    return "refused" in found ? found : found.entry;
  };
  const listing = reply !== undefined && shown > 0 ? (changes.entry(reply.changesId, 0) as { listing: Listing }).listing : undefined;
  return {
    changes,
    reply,
    got: { result: got.result, code: got.code, completeness: reply?.completeness, shown: reply?.files.length },
    want,
    files: firstDifference(Math.max(shown, old?.files.length ?? 0), (i) => reply?.files[i], (i) => old?.files[i]),
    entries: firstDifference(Math.max(shown, old?.files.length ?? 0) + 1, entryOf, (i) => old?.entry(i) ?? null),
    kept: listing === undefined || (old !== null && bytesOf(listing.raw).equals(old.kept.raw) && bytesOf(listing.offsets).equals(bytesOf(old.kept.offsets))),
  };
}

async function expectSame(raw: Uint8Array, objectFormat: ObjectFormat, label: string) {
  const c = await compared(raw, objectFormat);
  expect({ label, ...c.got, files: c.files, entries: c.entries, kept: c.kept }).toEqual({ label, ...c.want, files: -1, entries: -1, kept: true });
  return c;
}

const retainedListing = async (raw: Uint8Array, objectFormat: ObjectFormat = "sha1") => {
  const { changes, outcome } = read(raw, objectFormat);
  const reply = ((await outcome) as { value: Reply & { completeness: { reason?: string } } }).value;
  return { changes, reply, ...(changes.entry(reply.changesId, 0) as { listing: Listing; entry: RawEntry }) };
};

describe("readCommitChanges equals the v0.1.2 reply (T104 stage 1)", () => {
  caseTest(TASK, "every History fixture commit and parent in SHA-1 and SHA-256, and the 1,000-file commit, give the v0.1.2 reply, entries, and retained listing", [], async () => {
    const lists: [string, Buffer, ObjectFormat][] = [];
    const listOf = (repo: string, base: string, oid: string, objectFormat: ObjectFormat) => runGit(gitPath(), FIXTURE_ROOT, repo, commitChangesArgs(base, oid, objectFormat));
    for (const objectFormat of ["sha1", "sha256"] as const) {
      const built = buildHistory(gitPath(), `t104-lists-${objectFormat}`, objectFormat);
      for (const label of HISTORY_LABELS) {
        const oid = built.oids[label]!;
        const parents = runGit(gitPath(), FIXTURE_ROOT, built.repo, ["rev-list", "--parents", "-n", "1", oid]).toString("utf8").trim().split(" ").slice(1);
        for (const base of parents.length === 0 ? [EMPTY_TREE[objectFormat]] : parents) lists.push([`${objectFormat} ${label} ${base}`, listOf(built.repo, base, oid, objectFormat), objectFormat]);
      }
    }
    const wide = buildWide(gitPath(), "t104-wide");
    lists.push(["wide", listOf(wide.repo, wide.oids.base!, wide.oids.wide!, "sha1"), "sha1"]);
    for (const [label, raw, objectFormat] of lists) await expectSame(raw, objectFormat, label);
    expect(lists.length).toBeGreaterThan(HISTORY_LABELS.length * 2);
  }, TIMEOUT_MS);

  test("seeded listings with renames, modes, gitlinks, and non-UTF-8 names in SHA-1 and SHA-256, and the empty listing", async () => {
    for (const [f, objectFormat] of (["sha1", "sha256"] as const).entries()) {
      await expectSame(new Uint8Array(), objectFormat, `${objectFormat} empty`);
      for (let seed = 1; seed <= 60; seed++) {
        const rand = rng(seed * 2 + f);
        await expectSame(seeded(rand, objectFormat, 1 + Math.floor(rand() * 40)), objectFormat, `${objectFormat} seed ${seed}`);
      }
    }
  });

  test("damaged listings and copy records refuse with MALFORMED_GIT_OUTPUT exactly where v0.1.2 refuses", async () => {
    const results = new Map<string, number>();
    for (const [f, objectFormat] of (["sha1", "sha256"] as const).entries()) {
      for (let seed = 1; seed <= 150; seed++) {
        const rand = rng(1000 + seed * 2 + f);
        const c = await expectSame(damaged(rand, seeded(rand, objectFormat, 1 + Math.floor(rand() * 6))), objectFormat, `${objectFormat} damaged ${seed}`);
        results.set(c.got.result, (results.get(c.got.result) ?? 0) + 1);
      }
      const hex = "c".repeat(OID_HEX[objectFormat]);
      const rand = rng(7 + f);
      const copy = record(`:100644 100644 ${hex} ${hex} C075`, latin("a"), latin("b"));
      for (const before of [0, 1]) {
        const valid = seeded(rand, objectFormat, 2);
        const at = parseRawListing(valid, objectFormat, false)![before]!.start;
        const raw = Buffer.concat([valid.subarray(0, at), copy, valid.subarray(at)]);
        expect((await expectSame(raw, objectFormat, `${objectFormat} copy before record ${before}`)).got).toEqual({ result: "failed", code: "MALFORMED_GIT_OUTPUT", completeness: undefined, shown: undefined });
      }
    }
    expect({ failed: (results.get("failed") ?? 0) > 0, succeeded: (results.get("succeeded") ?? 0) > 0 }).toEqual({ failed: true, succeeded: true });
  });

  test("the result-bytes cut: each last path length across the bound gives the v0.1.2 reply", async () => {
    const count = 210;
    const size = 30_000;
    const fixedValue = (files: unknown[], completeness: object) => ({ changesId: crypto.randomUUID(), viewId: VIEW, oid: TARGET.sha1.oid, parents: [TARGET.sha1.base], base: { kind: "parent", index: 0, oid: TARGET.sha1.base }, files, completeness });
    const whole = (last: number) => v012(uniform(count, size, last), "sha1", false, fixedValue)!.reason === null;
    // The largest last path length whose listing fits whole.
    let lo = 1;
    let hi = 100_000;
    expect([whole(lo), whole(hi)]).toEqual([true, false]);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (whole(mid)) lo = mid;
      else hi = mid;
    }
    const reasons = new Set<string>();
    for (let last = lo - 60; last <= lo + 12; last++) reasons.add(((await expectSame(uniform(count, size, last), "sha1", `last path ${last} bytes`)).got.completeness as { reason?: string }).reason ?? "complete");
    expect([...reasons].sort()).toEqual([COMMIT_CUT, "complete"]);
  }, TIMEOUT_MS);

  test("the record cut, the result-bytes cut after it, and the listing-bytes cut give the v0.1.2 reply", async () => {
    const cases: [string, Buffer, string][] = [
      ["100,001 records with 12-byte paths", uniform(STATUS_LISTING_RECORDS + 1, 12), "STATUS_LISTING_RECORDS"],
      ["100,001 records with 15-byte paths", uniform(STATUS_LISTING_RECORDS + 1, 15), COMMIT_CUT],
      ["a listing above STATUS_LISTING_BYTES", uniform(Math.ceil((STATUS_LISTING_BYTES + 1) / 3_000), 3_000), COMMIT_CUT],
    ];
    for (const [label, raw, reason] of cases) expect([label, ((await expectSame(raw, "sha1", label)).got.completeness as { reason: string }).reason]).toEqual([label, reason]);
  }, TIMEOUT_MS);
});

describe("retained bytes (T104 stage 1)", () => {
  test("a cut listing retains a copy of its kept bytes, not the collector buffer", async () => {
    const cases: [string, Buffer][] = [
      ["record cut", uniform(STATUS_LISTING_RECORDS + 1, 12)],
      ["result-bytes cut", uniform(2_200, 3_000)],
      ["listing-bytes cut", uniform(Math.ceil((STATUS_LISTING_BYTES + 1) / 3_000), 3_000)],
    ];
    for (const [label, raw] of cases) {
      const { reply, listing } = await retainedListing(raw);
      expect({ label, limited: reply.completeness.reason !== undefined, buffer: listing.raw.buffer.byteLength, offset: listing.raw.byteOffset }).toEqual({ label, limited: true, buffer: listing.offsets.at(-1)!, offset: 0 });
    }
  }, TIMEOUT_MS);

  test("an entry holds copies of its paths, so a stored path does not keep the retained listing", async () => {
    const raw = Buffer.concat([record(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R092`, latin("old.txt"), latin("new.txt")), record(`:100644 100755 ${"a".repeat(40)} ${"a".repeat(40)} M`, latin("mode.sh"))]);
    const { changes, reply, listing } = await retainedListing(raw);
    for (const fileId of [0, 1]) {
      const { entry } = changes.entry(reply.changesId, fileId) as { entry: RawEntry };
      expect({ fileId, path: entry.path.buffer === listing.raw.buffer, oldPath: entry.oldPath === undefined ? null : entry.oldPath.buffer === listing.raw.buffer }).toEqual({ fileId, path: false, oldPath: fileId === 0 ? false : null });
    }
  });
});

describe("rawListingOffsets accepts and refuses as parseRawListing (T104 stage 1)", () => {
  // `parseRawListing` as offsets: the start of each entry, then the end of the last entry.
  const graph = (raw: Uint8Array, objectFormat: ObjectFormat, truncated: boolean) => {
    const entries = parseRawListing(raw, objectFormat, truncated);
    return entries === null ? null : [0, ...entries.map((e) => e.end)];
  };
  const scan = (raw: Uint8Array, objectFormat: ObjectFormat, truncated: boolean) => {
    const offsets = rawListingOffsets(raw, objectFormat, truncated);
    return offsets === null ? null : [...offsets];
  };
  // The first prefix and cut flag where the two parses differ. Null when they agree at every prefix length.
  const firstMismatch = (raw: Uint8Array, objectFormat: ObjectFormat) => {
    for (let n = 0; n <= raw.length; n++) {
      for (const truncated of [false, true]) {
        const prefix = raw.subarray(0, n);
        if (show(scan(prefix, objectFormat, truncated)) !== show(graph(prefix, objectFormat, truncated))) return { objectFormat, truncated, prefix: bytesOf(prefix).toString("latin1") };
      }
    }
    return null;
  };

  test("each hand record after a valid record, at every prefix length, cut and not cut", () => {
    for (const objectFormat of ["sha1", "sha256"] as const) {
      const n = OID_HEX[objectFormat];
      const [Z, A, B, C] = ["0", "a", "b", "c"].map((c) => c.repeat(n)) as [string, string, string, string];
      const other = "a".repeat(objectFormat === "sha1" ? 64 : 40);
      const rows: [string, ...string[]][] = [
        [`:000000 100644 ${Z} ${A} A`, "added.txt"],
        [`:100644 000000 ${A} ${Z} D`, "del.txt"],
        [`:100644 100755 ${A} ${A} M`, "mode.sh"],
        [`:100644 120000 ${A} ${B} T`, "typ"],
        [`:100644 100644 ${A} ${B} R092`, "ren.txt", "renamed.txt"],
        [`:100644 100644 ${A} ${B} R000`, "a", "b"],
        [`:100644 100644 ${A} ${A} R100`, "c", "d"],
        [`:160000 160000 ${A} ${B} M`, "lib"],
        [`:000000 120000 ${Z} ${B} A`, "lnk"],
        [`:100644 100644 ${Z} ${Z} M`, "zero-ids"],
        [`:100644 100644 ${A} ${Z} R050`, "x", "y"],
        [`:100644 100644 ${A} ${B} C075`, "a", "b"],
        [`:100644 100644 ${A} ${B} U`, "a"],
        [`:100644 100644 ${A} ${B} X`, "a"],
        [`:100644 100644 ${A} ${B} B`, "a"],
        [`:100644 100644 ${A} ${B} Q`, "a"],
        [`:100644 100644 ${A} ${B} r092`, "a", "b"],
        [`:100644 100644 ${A} ${B} R92`, "a", "b"],
        [`:100644 100644 ${A} ${B} R101`, "a", "b"],
        [`:100644 100644 ${A} ${B} R110`, "a", "b"],
        [`:100644 100644 ${A} ${B} R0a1`, "a", "b"],
        [`:100644 100644 ${A} ${B} R`, "a", "b"],
        [`:100644 100644 ${A} ${B} M100`, "a"],
        [`:100644 100644 ${A} ${B} R092`, "a"],
        [`:100644 100644 ${A} ${B} M`],
        [`:10644 100644 ${A} ${B} M`, "a"],
        [`:1006440 100644 ${A} ${B} M`, "a"],
        [`:100648 100644 ${A} ${B} M`, "a"],
        [`:100644 100644 ${other} ${B} M`, "a"],
        [`:100644 100644 ${A.toUpperCase()} ${B} M`, "a"],
        [`:100644 100644 ${A.slice(1)}g ${B} M`, "a"],
        [`100644 100644 ${A} ${B} M`, "a"],
        [`::100644 100644 ${A} ${B} M`, "a"],
        [`:100644  100644 ${A} ${B} M`, "a"],
        [`:100644 100644 ${A} ${B} M `, "a"],
        [`:100644 100644 ${A} ${B}  M`, "a"],
        [`:000000 100644 ${A} ${B} A`, "a"],
        [`:100644 100644 ${Z} ${B} A`, "a"],
        [`:000000 000000 ${Z} ${Z} A`, "a"],
        [`:000000 100644 ${Z} ${Z} A`, "a"],
        [`:100644 000000 ${A} ${B} D`, "a"],
        [`:100644 000000 ${Z} ${Z} D`, "a"],
        [`:000000 100644 ${Z} ${B} M`, "a"],
        [`:100644 000000 ${A} ${Z} T`, "a"],
        [`:000000 100644 ${Z} ${B} R090`, "a", "b"],
        [`:100644 100644 ${A} ${B} M`, ""],
        [`:100644 100644 ${A} ${B} R090`, "", "b"],
        [`:100644 100644 ${A} ${B} R090`, "a", ""],
      ];
      const ok = record(`:000000 100644 ${Z} ${C} A`, latin("ok.txt"));
      for (const [head, ...paths] of rows) expect({ head, mismatch: firstMismatch(Buffer.concat([ok, record(head, ...paths.map(latin)), ok]), objectFormat) }).toEqual({ head, mismatch: null });
    }
  });

  test("seeded and damaged listings, at every prefix length, cut and not cut", () => {
    for (const [f, objectFormat] of (["sha1", "sha256"] as const).entries()) {
      for (let seed = 1; seed <= 40; seed++) {
        const rand = rng(5000 + seed * 2 + f);
        const valid = seeded(rand, objectFormat, 1 + Math.floor(rand() * 4));
        expect({ seed, valid: firstMismatch(valid, objectFormat), damaged: firstMismatch(damaged(rand, valid), objectFormat) }).toEqual({ seed, valid: null, damaged: null });
      }
    }
  }, TIMEOUT_MS);
});
