// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `choose-side` and `mergetool`, data-model §2 and §11, plan.md D7, and spec FR-089 to FR-097.
// The index stages, the configuration listing, and fresh reads decide. No code here reads the text of a working file (spec FR-089, SC-015).

import type { ChangeEntry } from "../contracts/envelope";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, REF_LISTING_BYTES, REF_LISTING_RECORDS, STATUS_LISTING_BYTES, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { isObjectId } from "./commands";
import { createCollector, stepUnits } from "./git-runner";
import { settled, stepOf, wholeWorking, type Fact } from "./hunk-publish";
import { latin1 } from "./read-steps";
import type { OperationState, WorkingVersion } from "./snapshot";
import { changes } from "./sync";
import { observe } from "./sync-integrate";
import { readOut } from "./sync-review";
import type { ConfigEntry } from "./trust";
import { chooseSideArgs, mergetoolArgs, stagesArgs } from "./workbench-commands";
import { conclude, killed, registerWorkbenchAction, unavailable, type Common, type Observation, type PayloadOf, type Refused, type WorkbenchContext, type WorkbenchRun } from "./workbench-review";
import type { WslWhole } from "./wsl-files";

type ResolvePayload = PayloadOf<"choose-side" | "mergetool">;

// Data-model §11: the porcelain v2 `u` record codes (git-status(1)) and their texts.
const KIND_TEXTS: Readonly<Record<string, string>> = { UU: "Both modified", AA: "Both added", AU: "Added by us", UA: "Added by them", DU: "Deleted by us", UD: "Deleted by them", DD: "Both deleted" };
// gitformat-index(5): the modes of a regular file.
const REGULAR = new Set(["100644", "100755"]);
// git-checkout(1) `--ours` and `--theirs`: stage 2 and stage 3.
const SIDE_STAGE = { ours: 2, theirs: 3 } as const;
const MALFORMED = { code: "MALFORMED_GIT_OUTPUT" } as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Display text only: a ref name can hold bytes that are no valid UTF-8 (git-check-ref-format(1)).
const DISPLAY = new TextDecoder("utf-8", { ignoreBOM: true });
const read = (...args: string[]): string[] => ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", ...args];

interface Stage {
  stage: number;
  mode: string;
  oid: string;
}

// Spec FR-093: the effective `merge.tool` with its scope and origin, and the entries of its tool keys.
interface Tool {
  name: string;
  scope: ConfigEntry["scope"];
  origin: string;
  keys: { key: string; value: string | null; scope: ConfigEntry["scope"]; origin: string }[];
}

// Data-model §2 `choose-side`, `mergetool`. The dispatcher binds HEAD and the operation state.
interface ResolveBound {
  path: string;
  bytes: Uint8Array;
  stages: Stage[];
  working: WorkingVersion | WslWhole;
  tool: Tool | null;
}

// Contract Δ3 `choose-side` and `mergetool`: a `u` record holds the modes m1 m2 m3 mW and the object IDs h1 h2 h3. A stage without an entry has mode 000000 (git-status(1)).
function shownStages(e: ChangeEntry): Stage[] {
  return [1, 2, 3].flatMap((stage) => (e.modes![stage - 1] === "000000" ? [] : [{ stage, mode: e.modes![stage - 1]!, oid: e.oids![stage - 1]! }]));
}

// git-ls-files(1) `--stage -z`: `<mode> SP <object> SP <stage> TAB <path> NUL`. Only the records of `path` count, because a pathspec also matches the paths below a folder.
async function readStages(ctx: WorkbenchContext, path: string, bytes: Uint8Array): Promise<Fact<Stage[]>> {
  const out = await readOut(ctx, stagesArgs([path]), STATUS_LISTING_BYTES);
  if ("limited" in out) return { code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_BYTES" };
  if (!("value" in out)) return out;
  const text = latin1(out.value);
  if (text !== "" && !text.endsWith("\0")) return MALFORMED;
  const want = latin1(bytes);
  const stages: Stage[] = [];
  for (const record of text === "" ? [] : text.slice(0, -1).split("\0")) {
    const m = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (m === null || !isObjectId(m[2]!, ctx.workspace.objectFormat)) return MALFORMED;
    if (m[4] === want) stages.push({ stage: Number(m[3]), mode: m[1]!, oid: m[2]! });
  }
  return { value: stages };
}

// git-config(1): the last entry of a one-value key wins. A key without a value, or an empty value, names no tool.
function toolOf(entries: readonly ConfigEntry[]): Tool | Refused {
  const tool = entries.findLast((e) => e.key === "merge.tool");
  if (tool === undefined || tool.value === null || tool.value === "") return unavailable("no-merge-tool");
  // The decoded text of an inexact entry is not the value that Git reads.
  if (!tool.exact) return unavailable("unreadable");
  const name = tool.value;
  // git-mergetool--lib `setup_tool` sources "$MERGE_TOOLS_DIR/$tool" when that file exists, so a separator can name a file outside that folder.
  // The name is also the subsection of `mergetool.<name>.cmd`. The rule holds for every scope (plan.md D7).
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) return unavailable("merge-tool-name");
  const keys = entries.filter((e) => e.key === `mergetool.${name}.cmd` || e.key === `mergetool.${name}.path`).map(({ key, value, scope, origin }) => ({ key, value, scope, origin }));
  return { name, scope: tool.scope, origin: tool.origin, keys };
}

// Spec FR-092 and FR-094: a stage of each needed side, in a regular-file mode.
function refusalOf(stages: readonly Stage[], needed: readonly number[], missing: "side-missing" | "stages-missing"): Refused | null {
  const found = needed.map((n) => stages.find((s) => s.stage === n));
  if (found.some((s) => s === undefined)) return unavailable(missing);
  return found.every((s) => REGULAR.has(s!.mode)) ? null : unavailable("side-not-regular");
}

// Plan.md D7: theirs is MERGE_HEAD during a merge and REBASE_HEAD during a rebase. Other states give no commit fact.
async function theirsOf(ctx: WorkbenchContext, state: OperationState): Promise<Fact<string | null>> {
  const name = state === "merging" ? "MERGE_HEAD" : state === "rebasing" ? "REBASE_HEAD" : null;
  if (name === null) return { value: null };
  const exists = await stepOf(ctx, read("show-ref", "--exists", name), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in exists)) return exists;
  // git-show-ref(1) `--exists`: exit 2 for a missing ref.
  if (exists.exit.exitCode === 2) return { value: null };
  if (exists.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const out = await readOut(ctx, read("show-ref", "--verify", name), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in out) return MALFORMED;
  if (!("value" in out)) return out;
  // `show-ref --verify` prints `<object> SP <name> LF`.
  const text = latin1(out.value);
  const oid = text.slice(0, Math.max(0, text.length - name.length - 2));
  return text === `${oid} ${name}\n` && isObjectId(oid, ctx.workspace.objectFormat) ? { value: oid } : MALFORMED;
}

// Plan.md D7: a side names the refs that point at its commit (git-for-each-ref(1) `--points-at`). Without refs, the renderer shows the short ID.
async function sideName(ctx: WorkbenchContext, oid: string | null): Promise<Fact<{ oid: string; refs: string[] } | null>> {
  if (oid === null) return { value: null };
  const out = await readOut(ctx, read("for-each-ref", `--points-at=${oid}`, "--format=%(refname)"), REF_LISTING_BYTES);
  if ("limited" in out) return { code: "OUTPUT_LIMIT", reason: "REF_LISTING_BYTES" };
  if (!("value" in out)) return out;
  // A ref name holds no LF (git-check-ref-format(1)).
  const text = DISPLAY.decode(out.value);
  if (text !== "" && !text.endsWith("\n")) return MALFORMED;
  const refs = text === "" ? [] : text.slice(0, -1).split("\n");
  return refs.length > REF_LISTING_RECORDS ? { code: "OUTPUT_LIMIT", reason: "REF_LISTING_RECORDS" } : { value: { oid, refs } };
}

// Contract Δ3 reads of `choose-side` and `mergetool`, in this order: the entry, the tool, the command-line bound, the stages, the working file, and the side names.
async function observeResolve(ctx: WorkbenchContext, p: ResolvePayload, common: Common): Promise<Observation<ResolveBound>> {
  const w = ctx.workspace;
  const found = ctx.reader.entry(w.repositoryId, w.generation, p.snapshotId, p.entryId);
  if (!found.ok) return { refused: found.code };
  const e = found.entry;
  const kind = e.xy === undefined ? undefined : KIND_TEXTS[e.xy];
  if (e.category !== "conflicted" || kind === undefined || e.modes?.length !== 4 || e.oids?.length !== 3) return { refused: "INVALID_REQUEST" };
  const side = p.action === "choose-side" ? p.side : null;
  const tool = side === null ? toolOf(common.listing.entries) : null;
  if (tool !== null && "refused" in tool) return tool;
  const bytes = new Uint8Array(Buffer.from(e.pathBytes, "base64"));
  let path: string;
  try {
    path = UTF8.decode(bytes);
  } catch {
    return unavailable("path");
  }
  // Contract §6 command-line bound, measured for the route of each process.
  if (stepUnits(ctx, "read", stagesArgs([path])) > WINDOWS_COMMAND_LINE_UNITS || stepUnits(ctx, tool === null ? "integrate" : "mergetool", stepArgs(side, tool, path)) > WINDOWS_COMMAND_LINE_UNITS) return unavailable("limit");
  const stages = await readStages(ctx, path, bytes);
  if (!("value" in stages)) return stages;
  // Spec FR-092: the action binds the stages of the shown read. Another stage set asks for a refresh.
  if (!Bun.deepEquals(stages.value, shownStages(e), true)) return { refused: "STALE_SELECTION" };
  const refused = side === null ? refusalOf(stages.value, [2, 3], "stages-missing") : refusalOf(stages.value, [SIDE_STAGE[side]], "side-missing");
  if (refused !== null) return refused;
  // Feature 003 data-model §9 binding of Mark resolved: existence, type, mode, size, and raw digest. `changed`: the read could not bind the file.
  const working = await settled(ctx.signal, wholeWorking(ctx, bytes));
  if ("changed" in working) return { refused: "STALE_SELECTION" };
  if (!("value" in working)) return working;
  const ours = await sideName(ctx, common.head.state === "unborn" ? null : common.head.oid);
  if (!("value" in ours)) return ours;
  const theirsAt = await theirsOf(ctx, common.operationState);
  if (!("value" in theirsAt)) return theirsAt;
  const theirs = await sideName(ctx, theirsAt.value);
  if (!("value" in theirs)) return theirs;
  const plan = { path: e.pathBytes, kind: { xy: e.xy!, text: kind }, stages: stages.value, names: { ours: ours.value, theirs: theirs.value }, operation: common.operationState };
  const bound: ResolveBound = { path, bytes, stages: stages.value, working: working.value, tool };
  return { bound, plan: tool === null ? { ...plan, side } : { ...plan, tool: { name: tool.name, scope: tool.scope, origin: tool.origin } } };
}

// Contract Δ3 `runWorkbench` steps. Exactly one of `side` and `tool` is set.
const stepArgs = (side: "ours" | "theirs" | null, tool: Tool | null, path: string): string[] => (side !== null ? chooseSideArgs(side, path) : mergetoolArgs(tool!.name, path));

// Contract Δ3 `runWorkbench` step 4. Spec FR-096: for `mergetool`, the fresh index read decides, never the exit status of Git's mergetool.
async function runResolve(r: WorkbenchRun, p: ResolvePayload, b: ResolveBound): Promise<void> {
  const action = p.action;
  const end = await r.step(stepArgs(p.action === "choose-side" ? p.side : null, b.tool, b.path), b.tool === null ? "resolve" : "mergetool");
  const settledRun = await r.reconcile([end]);
  if (settledRun === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  const o = await observe(r.q, killed([end]));
  if (!("value" in o)) return r.unknown(o, { action });
  const stages = await readStages(r.q, b.path, b.bytes);
  if (!("value" in stages)) return r.unknown(stages, { action });
  const working = await settled(r.q.signal, wholeWorking(r.q, b.bytes));
  if (!("value" in working) && !("changed" in working)) return r.unknown(working, { action });
  const now = o.value;
  const staged = !stages.value.some((s) => s.stage > 0);
  const result = { action, staged, operationState: now.state };
  const others = changes(r.before.refs, now.refs).length === 0 && Bun.deepEquals(now.head, r.common.head, true) && !now.lock;
  // wt-status.c `wt_status_get_state`: without a marker, the state is `conflicted` only while a stage above 0 remains.
  const state = r.before.state === "conflicted" && now.index.unmerged === 0 ? "normal" : r.before.state;
  const changed = !others || now.state !== r.before.state || now.index.fingerprint !== r.before.index.fingerprint || !("value" in working) || !Bun.deepEquals(working.value, b.working, true);
  // Spec FR-091: Choose ours and Choose theirs keep the path unmerged.
  const done = b.tool === null ? end.exit?.exitCode === 0 : staged;
  const intended = others && now.state === state && (b.tool === null ? Bun.deepEquals(stages.value, b.stages, true) : staged);
  conclude(r, { done, intended, changed, canceled: settledRun.canceled, failed: done ? null : end }, result);
}

registerWorkbenchAction<"choose-side", ResolveBound>("choose-side", { observe: observeResolve, started: (p) => (p.side === "ours" ? "choose-ours" : "choose-theirs"), run: runResolve });
registerWorkbenchAction<"mergetool", ResolveBound>("mergetool", { observe: observeResolve, started: () => "mergetool", run: runResolve });
