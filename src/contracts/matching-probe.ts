// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ3 "Matching probe" (specs/002-full-history/contracts/operations.md). These values are contract values. This module starts no process.
// The probe imports the stream into an empty bare repository. Each run takes the `searchHistory` argv with one `--grep` per pattern and the tip on stdin.
// More than one `--grep` matches a commit when any pattern matches (git-rev-list(1) "--grep").

const IDENT = "Arbareto Probe <probe@arbareto.invalid>";
const TIME = 1_700_000_000;
const REF = "refs/heads/probe";

// The patterns of the two runs: lower case first, then upper case.
export const MATCHING_PROBE_GREPS = [
  ["виправлення", "є", "і", "ї", "ґ", "ß"],
  ["ВИПРАВЛЕННЯ", "Є", "І", "Ї", "Ґ", "ẞ"],
] as const;

export interface ProbeCommit {
  // The FR-023 or FR-024 case.
  readonly label: string;
  readonly message: Uint8Array;
  readonly encoding: "windows-1251" | null;
  // The SHA-1 OID of the commit object that the stream gives.
  readonly oid: string;
  // True when each run must list the commit.
  readonly matches: boolean;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const probe = (label: string, oid: string, matches = true): ProbeCommit => ({ label, message: utf8(`probe ${label}\n`), encoding: null, oid, matches });

// One line of commits, oldest first. Each commit has the empty tree and the time TIME plus its index.
export const MATCHING_PROBE_COMMITS: readonly ProbeCommit[] = [
  probe("виправлення", "e68bfe2bbf1e8eebd47b9f67805f87fd499d6f7c"),
  probe("ВИПРАВЛЕННЯ", "d13d15617d70a261ae29fe09e43e00f959e759c5"),
  probe("є", "e7808fe944ae144e00136097d9887b1b3e99f6e6"),
  probe("Є", "6334365161e519de3881ff010b1a65f5f73c8dae"),
  probe("і", "4f70827cd801f9622871b17daaf9416552127574"),
  probe("І", "e4a9d33bfac0756563a081a438674633f6e4c269"),
  probe("ї", "c9147d24f36444fe7c1580a534902659c65ea7c1"),
  probe("Ї", "6a1c1a71c1e9ec98b371d8709ada1b65a2653a2d"),
  probe("ґ", "110dedf9a10cc0c76ac92b9c159193c2556bb364"),
  probe("Ґ", "31bb4cda9edb2bd2908dae682d2d99a36482a62c"),
  probe("ß", "0a4907691a7943975dae2df7adb1cd8877509573"),
  probe("ẞ", "fe50942649d41d5834dd8222622ad2e58bffe92a"),
  // FR-023: simple case folding never matches "ß" against "SS".
  probe("SS", "4e7ef078a7d0321c94da31f36b1783494bc7e199", false),
  {
    label: "windows-1251 Виправлення",
    // "probe legacy Виправлення\n" in windows-1251 (WHATWG Encoding index).
    message: Uint8Array.from([...utf8("probe legacy "), 0xc2, 0xe8, 0xef, 0xf0, 0xe0, 0xe2, 0xeb, 0xe5, 0xed, 0xed, 0xff, 0x0a]),
    encoding: "windows-1251",
    oid: "f19ce946c9056b2f3b27b3f0987db910e1b46846",
    matches: true,
  },
  probe("ascii", "e5743b867921477b19ba37c43a402b8a7a72f2d2", false),
];

export const MATCHING_PROBE_TIP = MATCHING_PROBE_COMMITS[MATCHING_PROBE_COMMITS.length - 1]!.oid;

// Both runs expect the same sets: each case holds both letter cases, so each run matches each case once through folding.
export const MATCHING_PROBE_RUNS = MATCHING_PROBE_GREPS.map((grep) => ({
  grep,
  matches: MATCHING_PROBE_COMMITS.filter((c) => c.matches).map((c) => c.oid),
  nonMatches: MATCHING_PROBE_COMMITS.filter((c) => !c.matches).map((c) => c.oid),
}));

// git-fast-import(1) commands: one `commit` per probe commit, each on REF with the previous commit as `from`.
export const MATCHING_PROBE_STREAM: Uint8Array = (() => {
  const parts: Uint8Array[] = [];
  MATCHING_PROBE_COMMITS.forEach((c, i) => {
    const time = `${TIME + i} +0000`;
    const encoding = c.encoding === null ? "" : `encoding ${c.encoding}\n`;
    parts.push(utf8(`commit ${REF}\nmark :${i + 1}\nauthor ${IDENT} ${time}\ncommitter ${IDENT} ${time}\n${encoding}data ${c.message.length}\n`), c.message, utf8(`\n${i === 0 ? "" : `from :${i}\n`}\n`));
  });
  const stream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (stream.set(p, at), at + p.length), 0);
  return stream;
})();
