// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T012: the topology table of a history view (plan.md P1 and D2, data-model.md §3, contract Δ3 `loadHistory`, spec FR-003, FR-004, FR-045).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NATIVE_CHUNK_BYTES } from "../../src/contracts/limits";
import type { ObjectFormat } from "../../src/git-service/commands";
import { HistoryTopology, type TopologyFailure } from "../../src/git-service/history-topology";
import { printOrigin } from "../origin";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF08 } from "./fixtures";
import { describeGit } from "./git-binary";
import { buildSmallFixtures, H200K, largeCase, largeFixture, rng, startPoints } from "./history-fixtures";
import { VIEW } from "./history-order-facts";

printOrigin("../../src/git-service/history-topology.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const TASK = "T012";
const MALFORMED: TopologyFailure = { code: "MALFORMED_GIT_OUTPUT" };
const PARENTS_LIMIT: TopologyFailure = { code: "OUTPUT_LIMIT", reason: "HISTORY_PARENTS_PER_COMMIT" };
const ORDER: TopologyFailure = { code: "HISTORY_CHANGED", reason: "order" };
const HEX = { sha1: 40, sha256: 64 } as const;

const encode = (lines: string[]) => Buffer.from(lines.map((l) => `${l}\n`).join(""), "latin1");

// Feeds `bytes` in random frames of 1 to `maxFrame` bytes. Returns the first failure.
function feed(topology: HistoryTopology, bytes: Uint8Array, random: () => number, maxFrame: number): TopologyFailure | null {
  for (let at = 0; at < bytes.length; ) {
    const end = Math.min(bytes.length, at + 1 + Math.floor(random() * maxFrame));
    const failure = topology.push(bytes.subarray(at, end));
    if (failure !== null) return failure;
    at = end;
  }
  return null;
}

function expectRows(topology: HistoryTopology, lines: string[]): void {
  expect(topology.rows).toBe(lines.length);
  for (const [row, line] of lines.entries()) {
    const [oid, ...parents] = line.split(" ");
    expect({ row, oid: topology.oid(row), parents: topology.parents(row), rowOf: topology.rowOf(oid!) }).toEqual({ row, oid: oid!, parents, rowOf: row });
  }
}

// A random DAG in child-before-parent order. Each parent is a later row.
function randomLines(format: ObjectFormat, count: number, random: () => number): string[] {
  const oid = () => Array.from({ length: HEX[format] }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
  const oids = Array.from({ length: count }, oid);
  return oids.map((o, i) => {
    const later = count - 1 - i;
    const parents = new Set(Array.from({ length: Math.min(later, Math.floor(random() * 4)) }, () => oids[i + 1 + Math.floor(random() * later)]!));
    return [o, ...parents].join(" ");
  });
}

// The own fields of the table: typed arrays and scalars only.
function tableBytes(topology: HistoryTopology): number {
  let bytes = 0;
  for (const [name, value] of Object.entries(topology)) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    else if (value !== null && typeof value === "object" && !("code" in value)) throw new Error(`field ${name} is a ${value.constructor.name}, not a typed array`);
  }
  return bytes;
}

describe("topology table", () => {
  for (const format of ["sha1", "sha256"] as const) {
    test(`${format}: random frame splits give the rows of one parse`, () => {
      const random = rng(format === "sha1" ? 1 : 2);
      for (let round = 0; round < 20; round++) {
        const lines = randomLines(format, 1 + Math.floor(random() * 600), random);
        const topology = new HistoryTopology(format);
        topology.beginStep();
        expect(feed(topology, encode(lines), random, round % 2 === 0 ? 3 : 300)).toBeNull();
        expect(topology.end()).toBeNull();
        expect(topology.pending).toBe(0);
        expectRows(topology, lines);
        expect(topology.rowOf("f".repeat(HEX[format]))).toBe(-1);
      }
    });
  }

  test("the table uses typed arrays and no JS Map of OID strings", () => {
    const topology = new HistoryTopology("sha1");
    topology.beginStep();
    topology.push(encode(randomLines("sha1", 3000, rng(3))));
    expect(topology.end()).toBeNull();
    for (const value of Object.values(topology)) expect(value instanceof Map || value instanceof Set || Array.isArray(value)).toBe(false);
    expect(tableBytes(topology)).toBeGreaterThan(0);
  });

  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => x.repeat(40)) as [string, string, string, string];

  test("a duplicate row, a parent that already showed, and a parent pending at exit 0 give MALFORMED_GIT_OUTPUT", () => {
    const run = (lines: string[]) => {
      const topology = new HistoryTopology("sha1");
      topology.beginStep();
      return topology.push(encode(lines)) ?? topology.end();
    };
    expect(run([`${a} ${b}`, b])).toBeNull();
    expect(run([`${a} ${b}`, `${b}`, `${a}`])).toEqual(MALFORMED);
    expect(run([`${a}`, `${b} ${a}`])).toEqual(MALFORMED);
    expect(run([`${a} ${a}`])).toEqual(MALFORMED);
    expect(run([`${a} ${b} ${c}`, `${b}`])).toEqual(MALFORMED);
  });

  test("a failed line adds no row, and the failure stays", () => {
    const topology = new HistoryTopology("sha1");
    topology.beginStep();
    expect(topology.push(encode([`${a} ${b}`, `${b}`, `${c} ${a}`]))).toEqual(MALFORMED);
    expectRows(topology, [`${a} ${b}`, `${b}`]);
    expect(topology.push(encode([`${d}`]))).toEqual(MALFORMED);
    expect(topology.end()).toEqual(MALFORMED);
  });

  test("malformed lines give MALFORMED_GIT_OUTPUT", () => {
    for (const bytes of [`${a.toUpperCase()}\n`, `${a}  ${b}\n`, `${a} \n`, `\n`, `${a.slice(1)}\n`, `${a}x\n`, `${a}\r\n`]) {
      const topology = new HistoryTopology("sha1");
      topology.beginStep();
      expect({ bytes, failure: topology.push(Buffer.from(bytes, "latin1")) }).toEqual({ bytes, failure: MALFORMED });
    }
    const sha256 = new HistoryTopology("sha256");
    sha256.beginStep();
    expect(sha256.push(encode([a]))).toEqual(MALFORMED);
    const unended = new HistoryTopology("sha1");
    unended.beginStep();
    expect(unended.push(Buffer.from(a, "latin1"))).toBeNull();
    expect(unended.end()).toEqual(MALFORMED);
  });

  test("a stream that ends at a stop row with pending parents gives no error, and the next step continues with them", () => {
    const random = rng(4);
    const lines = randomLines("sha1", 2000, random);
    const topology = new HistoryTopology("sha1");
    for (const s of [1, 37, 500, 1300]) {
      topology.beginStep();
      // The next step streams from row 0 again (plan.md D2).
      expect(feed(topology, encode(lines.slice(0, s)), random, 200)).toBeNull();
      expect(topology.rows).toBe(s);
      if (s > 1) expect(topology.pending).toBeGreaterThan(0);
    }
    topology.beginStep();
    expect(feed(topology, encode(lines), random, 200)).toBeNull();
    expect(topology.end()).toBeNull();
    expect(topology.pending).toBe(0);
    expectRows(topology, lines);
  });

  test("a re-read row that differs, or an exit 0 before the held rows, gives HISTORY_CHANGED order", () => {
    const step = (held: string[], next: string[]) => {
      const topology = new HistoryTopology("sha1");
      topology.beginStep();
      expect(topology.push(encode(held))).toBeNull();
      topology.beginStep();
      return topology.push(encode(next)) ?? topology.end();
    };
    expect(step([`${a} ${b}`, `${b}`], [`${a} ${b}`, `${b}`])).toBeNull();
    expect(step([`${a} ${b}`, `${b} ${c}`], [`${a} ${b}`, `${b} ${d}`])).toEqual(ORDER);
    expect(step([`${a} ${b}`, `${b}`], [`${a} ${b}`, `${b} ${c}`])).toEqual(ORDER);
    expect(step([`${a} ${b} ${c}`], [`${a} ${c} ${b}`])).toEqual(ORDER);
    expect(step([`${a} ${b}`], [`${b}`, `${a} ${b}`])).toEqual(ORDER);
    expect(step([`${a} ${b}`, `${b}`], [`${a} ${b}`])).toEqual(ORDER);
  });

  test("a line with more than 1 + 64 OIDs gives OUTPUT_LIMIT HISTORY_PARENTS_PER_COMMIT", () => {
    const random = rng(5);
    for (const format of ["sha1", "sha256"] as const) {
      const lines = randomLines(format, 70, random).map((l) => l.split(" ")[0]!);
      for (const [parents, maxFrame] of [[64, 97], [65, 97], [65, 1 << 20], [200, 97], [200, 1 << 20]] as const) {
        const topology = new HistoryTopology(format);
        topology.beginStep();
        const failure = feed(topology, encode([lines[0]!, [lines[1], ...lines.slice(2, 2 + parents)].join(" "), ...lines.slice(2, 2 + parents)]), random, maxFrame);
        expect({ format, parents, failure }).toEqual({ format, parents, failure: parents <= 64 ? null : PARENTS_LIMIT });
        expect(topology.rows).toBe(parents <= 64 ? 2 + parents : 1);
      }
    }
  });
});

describeGit("topology table on Git output", (git) => {
  useFixtureRoot();

  const viewOf = (root: string, repo: string) => ownedGit(git, root, repo, VIEW, { input: Buffer.from(startPoints(git, root, repo).map((s) => `${s}\n`).join("")) });
  const linesOf = (out: Buffer) => out.toString("latin1").split("\n").filter((l) => l !== "");

  function parse(format: ObjectFormat, out: Buffer, random: () => number, maxFrame: number): { topology: HistoryTopology; failure: TopologyFailure | null } {
    const topology = new HistoryTopology(format);
    topology.beginStep();
    return { topology, failure: feed(topology, out, random, maxFrame) ?? topology.end() };
  }

  test("every small fixture and a SHA-256 repository parse across random frame splits", () => {
    const random = rng(6);
    for (const fixture of buildSmallFixtures(git, "t012")) {
      const out = viewOf(FIXTURE_ROOT, fixture.repo);
      const { topology, failure } = parse("sha1", out, random, 500);
      if (fixture.name === "octopus-65") {
        // The 65-parent merge: the rows above it stay.
        const lines = linesOf(out);
        const merge = lines.findIndex((l) => l.split(" ").length > 65);
        expect({ merge: merge > 0, failure }).toEqual({ merge: true, failure: PARENTS_LIMIT });
        expectRows(topology, lines.slice(0, merge));
        continue;
      }
      expect({ name: fixture.name, failure }).toEqual({ name: fixture.name, failure: null });
      expectRows(topology, linesOf(out));
    }
    const repo = join(buildF08(git, "t012-sha256", "sha256").root, "repo");
    const out = viewOf(FIXTURE_ROOT, repo);
    const { topology, failure } = parse("sha256", out, random, 50);
    expect(failure).toBeNull();
    expect(topology.rows).toBe(2);
    expectRows(topology, linesOf(out));
  }, 300_000);

  largeCase(TASK, "H200K: the table holds every row, and the bytes per commit are recorded", H200K, () => {
    const out = viewOf(PERF_CACHE_ROOT, largeFixture(git, H200K, false).repo);
    const topology = new HistoryTopology("sha1");
    topology.beginStep();
    for (let at = 0; at < out.length; at += NATIVE_CHUNK_BYTES) expect(topology.push(out.subarray(at, at + NATIVE_CHUNK_BYTES))).toBeNull();
    expect(topology.end()).toBeNull();
    const lines = linesOf(out);
    expect(topology.rows).toBe(lines.length);
    for (let row = 0; row < lines.length; row += 997) expect(`${topology.oid(row)}${topology.parents(row).map((p) => ` ${p}`).join("")}`).toBe(lines[row]!);
    const bytes = tableBytes(topology);
    console.log(`OBSERVATION ${TASK}: H200K: ${topology.rows} rows; the topology table holds ${bytes} bytes of typed arrays, ${(bytes / topology.rows).toFixed(1)} bytes per commit (SHA-1, allocated capacity) (experiment)`);
  }, 30 * 60_000);
});
