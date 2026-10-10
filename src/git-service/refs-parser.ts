// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §3 "References result": the record checks and the result fields. A pure parser of untrusted Git output.

import { isUtf8 } from "node:buffer";
import type { RefEntry } from "../contracts/envelope";
import { isObjectId, type ObjectFormat } from "./commands";

export interface RefList {
  refs: RefEntry[];
  current: { name: string; objectId: string } | null;
}

const KINDS: readonly [prefix: string, kind: RefEntry["kind"]][] = [
  ["refs/heads/", "branch"],
  ["refs/remotes/", "remote"],
  ["refs/tags/", "tag"],
];
const OBJECT_TYPES = new Set(["commit", "tag", "tree", "blob"]);
const PEELED_TYPES = new Set(["commit", "tree", "blob"]);
// Spec FR-008: invalid UTF-8 shows replacement characters. A byte order mark stays text.
const lossy = new TextDecoder("utf-8", { ignoreBOM: true });
const bytesOf = (latin1: string) => Buffer.from(latin1, "latin1");
const textOf = (latin1: string) => lossy.decode(bytesOf(latin1));
const orNull = (latin1: string) => (latin1 === "" ? null : textOf(latin1));
const isRefOrEmpty = (latin1: string) => latin1 === "" || latin1.startsWith("refs/");

// Input: the stdout of `refsArgs`. Each record is eight fields with seven NUL separators, and LF ends it (git-for-each-ref(1) `%00`).
// Null: one record breaks one record check, so the whole result is `MALFORMED_GIT_OUTPUT`.
export function parseRefs(stdout: Uint8Array, objectFormat: ObjectFormat): RefList | null {
  const text = Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength).toString("latin1");
  if (text !== "" && !text.endsWith("\n")) return null;
  const records = text === "" ? [] : text.slice(0, -1).split("\n").map((line) => line.split("\0"));
  const listed = new Set<string>();
  const parsed: { kind: RefEntry["kind"]; name: string; fields: string[] }[] = [];
  let current: RefList["current"] = null;
  for (const fields of records) {
    if (fields.length !== 8) return null;
    const [refname, objectId, objectType, peeledId, peeledType, symref, upstream, head] = fields as [string, string, string, string, string, string, string, string];
    const prefix = KINDS.find(([p]) => refname.startsWith(p));
    if (prefix === undefined) return null;
    if (!isObjectId(objectId, objectFormat) || !OBJECT_TYPES.has(objectType)) return null;
    const peeled = objectType === "tag" ? isObjectId(peeledId, objectFormat) && PEELED_TYPES.has(peeledType) : peeledId === "" && peeledType === "";
    if (!peeled || !isRefOrEmpty(symref) || !isRefOrEmpty(upstream)) return null;
    if (head !== "*" && head !== " ") return null;
    if (head === "*") {
      if (current !== null || prefix[1] !== "branch") return null;
      current = { name: textOf(refname.slice(prefix[0].length)), objectId };
    }
    listed.add(refname);
    parsed.push({ kind: prefix[1], name: refname.slice(prefix[0].length), fields });
  }
  const refs = parsed.map(({ kind, name, fields }): RefEntry => {
    const [, objectId, objectType, peeledId, peeledType, symref, upstream] = fields as [string, string, RefEntry["objectType"], string, string, string, string];
    return {
      kind,
      name: textOf(name),
      invalidUtf8: !isUtf8(bytesOf(name)),
      objectId,
      objectType,
      peeledId: peeledId === "" ? null : peeledId,
      peeledType: peeledType === "" ? null : (peeledType as NonNullable<RefEntry["peeledType"]>),
      symref: orNull(symref),
      upstream: orNull(upstream),
      upstreamPresent: upstream !== "" && listed.has(upstream),
      commitId: objectType === "commit" ? objectId : peeledType === "commit" ? peeledId : null,
    };
  });
  return { refs, current };
}
