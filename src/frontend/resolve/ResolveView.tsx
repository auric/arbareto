// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Type-only imports keep zod out of the renderer bundle.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import type { ChangeEntry, Comparison, ReviewWorkbenchResult } from "../../contracts/envelope";
import { codeText, failureText, unknownFormText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { decide, runFileAction, type FileControlsProps } from "../changes/FileControls";
import { BLOCKED_TEXT, type Blocked, type StagingTarget } from "../changes/HunkControls";
import { RUNNING_REASON, RunningTooltip } from "../components/running-tooltip";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import { shortId, trackOperation, type StatusOperation } from "../status/OperationStatus";
import { reviewWithTrust, WORKBENCH_TRUST, type AskTrust } from "../trust/ask";
import { KIND_TEXTS, TEXTS, type Side } from "./texts";

// Feature 004 spec FR-089 to FR-096, plan.md D7 and D15 "P2 regions" and "Resolve view texts", contract Δ3 `choose-side` and `mergetool`, data-model §11.
// Only the review and run results decide. The view never reads the text of the working file or of Git's output (spec FR-089, FR-096).

export type ResolveViewProps = {
  /** The selected Conflicted entry of the shown snapshot. */
  entry: ChangeEntry;
  snapshotId: string;
  /** The shown comparison of the entry. Mark resolved binds it (feature 003 contract Δ4). */
  comparison: Comparison | null;
  bridge: Pick<ReturnType<typeof createBridge>, "reviewWorkbench" | "runWorkbench" | "applyFile" | "cancel">;
  target: StagingTarget | null;
  blocked: Blocked;
  trust?: FileControlsProps["trust"];
  eligibility?: FileControlsProps["eligibility"];
  /** Plan.md D12 "Ask": a trust refusal of a click review asks once (contract Δ7). */
  askTrust?: AskTrust;
  onOperation(op: StatusOperation): void;
  /** The store's `ended("runWorkbench", response)`. */
  onEnded(response: BridgeResponse): void;
  /** The 001 reconcile read after Mark resolved. */
  onFileEnded(response: BridgeResponse): void;
  /** The second live element of the status bar. */
  onStatus(text: string | null): void;
  /** Opens the Settings view (spec FR-093: the page Editor and tools). */
  onOpenSettings(): void;
};

type Reviewed = Extract<z.infer<typeof ReviewWorkbenchResult>, { workbenchToken: string }>;
type Plan = Extract<Reviewed, { action: "choose-side" | "mergetool" }>["plan"];
type SideName = Plan["names"]["ours"];
type Item = Side | "mergetool";
type Review = { state: string; token: string | null; plan: Plan | null; code: string | null; reason: string | null; names: Plan["names"] | null };
type Active = { item: Item; tool: string | null; operationId: string | null; cancelRequested: boolean };
const ITEMS: readonly Item[] = ["ours", "theirs", "mergetool"];

function reviewOf(response: BridgeResponse): Review {
  const result = isObject(response.result) ? response.result : {};
  const token = response.state === "succeeded" && typeof result.workbenchToken === "string" ? result.workbenchToken : null;
  const plan = token !== null && isObject(result.plan) ? (result.plan as Plan) : null;
  // Contract Δ3: a stage refusal also carries the side names, so a DD conflict shows them.
  const names = plan?.names ?? (token === null && isObject(result.names) ? (result.names as Plan["names"]) : null);
  return { state: response.state, token, plan, code: token === null ? (response.code ?? response.state) : null, reason: typeof result.reason === "string" ? result.reason : null, names };
}

/** Plan.md D7: the refs at the side's commit, else its short ID. A side without a commit fact has no name. */
const nameOf = (side: SideName | undefined): string | null => (side === null || side === undefined ? null : side.refs.length > 0 ? side.refs.map(shortRef).join(", ") : shortId(side.oid));
const labelOf = (item: Item, names: Plan["names"] | null) => (item === "mergetool" ? TEXTS.openTool : TEXTS.choose(item, nameOf(names?.[item])));

/** The D15 text of a refused review. Unmapped codes and reasons show the code. */
function refusalText(item: Item, review: Review): ReactNode {
  const label = item === "mergetool" ? TEXTS.openTool : TEXTS.verb(item);
  if (review.state === "succeeded") return unknownFormText(label);
  if (review.code === "TRUST_REQUIRED" || review.code === "TRUST_CHANGED") return TEXTS.trust;
  if (review.code === "STALE_SELECTION" || review.code === "STALE_REVIEW") return TEXTS.stale;
  if (review.code === "WORKBENCH_UNAVAILABLE" && review.reason !== null) {
    const own = item === "mergetool" ? TEXTS.toolReasons : TEXTS.sideReasons;
    return own[review.reason] ?? TEXTS.reasons[review.reason] ?? codeText(TEXTS.unavailable(label), review.reason);
  }
  return codeText(TEXTS.unavailable(label), review.code ?? "unknown");
}

const payloadOf = (item: Item, snapshotId: string, entryId: string) =>
  item === "mergetool" ? { action: "mergetool" as const, snapshotId, entryId } : { action: "choose-side" as const, snapshotId, entryId, side: item };

function ItemRow({ label, reason, quiet, onRun, children }: { label: string; reason: ReactNode; quiet: boolean; onRun(): void; children?: ReactNode }) {
  const id = useId();
  const has = reason !== null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <RunningTooltip reason={quiet ? RUNNING_REASON : null}>
          <Button variant="outline" className="self-start" disabled={has} focusableWhenDisabled aria-describedby={has ? id : undefined} onClick={onRun}>
            {label}
          </Button>
        </RunningTooltip>
        {children}
      </div>
      {has ? (
        <span id={id} className={quiet ? "sr-only" : "text-muted-text"}>
          {reason}
        </span>
      ) : null}
    </div>
  );
}

/** The resolve view of one Conflicted entry. It replaces the diff (plan.md D15 "P2 regions"). */
export function ResolveView(props: ResolveViewProps) {
  const { entry, snapshotId, comparison, bridge, target, blocked, onOperation, onEnded, onStatus, onOpenSettings } = props;
  // The second review after an approval takes the target and the snapshot of the full read.
  const live = useRef(props);
  live.current = props;
  const key = `${snapshotId}:${entry.entryId}`;
  // The display reviews of the shown entry, by item. A token here never starts a run: each run reviews again (contract Δ3).
  const [shown, setShown] = useState<{ key: string; value: Partial<Record<Item, Review>> }>({ key, value: {} });
  const [confirm, setConfirm] = useState<{ side: Side; name: string | null; token: string } | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [line, setLine] = useState<{ path: string; text: ReactNode } | null>(null);
  const busy = useRef(false);
  const repositoryId = target?.repositoryId ?? null;
  const generation = target?.repositoryGeneration ?? null;

  // Contract Δ3 "One read slot": the reviews run one after the other. A newer entry or snapshot drops the older answers.
  useEffect(() => {
    if (repositoryId === null || generation === null) return;
    let live = true;
    void (async () => {
      for (const item of ITEMS) {
        const response = await bridge.reviewWorkbench({ repositoryId, repositoryGeneration: generation }, payloadOf(item, snapshotId, entry.entryId));
        if (!live) return;
        setShown((s) => ({ key, value: { ...(s.key === key ? s.value : {}), [item]: reviewOf(response) } }));
      }
    })();
    return () => void (live = false);
  }, [bridge, repositoryId, generation, key, snapshotId, entry.entryId]);

  const value = shown.key === key ? shown.value : {};
  const plans = ITEMS.map((item) => value[item]?.plan ?? null);
  const plan = plans.find((p) => p !== null) ?? null;
  const names = ITEMS.map((item) => value[item]?.names ?? null).find((n) => n !== null) ?? null;
  const kind = (entry.xy === undefined ? undefined : KIND_TEXTS[entry.xy]) ?? plan?.kind.text ?? null;
  const pending = ITEMS.some((item) => value[item] === undefined);
  const tool = value.mergetool?.plan !== null && value.mergetool?.plan !== undefined && "tool" in value.mergetool.plan ? value.mergetool.plan.tool.name : null;
  // Plan D15 running rule. Mark resolved and the resolve actions run during a merge or a rebase (spec 001 FR-016 change).
  const quiet = active !== null || blocked === "busy" || blocked === "running";
  const stateReason = target === null ? BLOCKED_TEXT.stale : blocked !== null && blocked !== "conflicted" && blocked !== "operation" ? BLOCKED_TEXT[blocked] : null;
  const reasonOf = (item: Item): ReactNode => {
    if (quiet) return RUNNING_REASON;
    if (stateReason !== null) return stateReason;
    const review = value[item];
    if (review === undefined) return TEXTS.pending;
    // Spec FR-069: an action asks at its first use, so a trust refusal keeps the item available while an ask exists.
    if (review.token === null && (review.code === "TRUST_REQUIRED" || review.code === "TRUST_CHANGED") && props.askTrust !== undefined) return null;
    return review.token === null ? refusalText(item, review) : null;
  };
  const say = (text: ReactNode, status: string | null) => {
    setLine({ path: entry.pathBytes, text });
    onStatus(status);
  };

  async function review(item: Item): Promise<Review | null> {
    if (target === null) return null;
    const send = () => {
      const now = live.current;
      // A changed selection keeps the IDs of this entry, so the review refuses as stale.
      const same = now.entry.pathBytes === entry.pathBytes;
      return bridge.reviewWorkbench(now.target ?? target, payloadOf(item, same ? now.snapshotId : snapshotId, same ? now.entry.entryId : entry.entryId));
    };
    const again = reviewOf(await reviewWithTrust(send, WORKBENCH_TRUST[payloadOf(item, snapshotId, entry.entryId).action], props.askTrust));
    if (again.token === null) say(refusalText(item, again), null);
    return again.token === null ? null : again;
  }

  async function start(item: Item) {
    if (busy.current || reasonOf(item) !== null) return;
    busy.current = true;
    setLine(null);
    try {
      const again = await review(item);
      if (again === null || again.plan === null) return;
      if (item !== "mergetool") return setConfirm({ side: item, name: nameOf(again.plan.names[item]), token: again.token! });
      await run("mergetool", again.token!, "tool" in again.plan ? again.plan.tool.name : "");
    } finally {
      busy.current = false;
    }
  }

  /** `name` is the tool name for `mergetool`, else the side name of the confirmation. */
  async function run(item: Item, token: string, name: string | null) {
    if (target === null) return;
    const path = entry.path;
    const texts = item === "mergetool" ? TEXTS.toolRunTexts(name ?? "") : TEXTS.runTexts(item);
    setConfirm(null);
    setActive({ item, tool: name, operationId: null, cancelRequested: false });
    const response = await trackOperation(
      "runWorkbench",
      undefined,
      (onProgress) => bridge.runWorkbench({ repositoryId: target.repositoryId }, { workbenchToken: token, start: true }, onProgress),
      (op) => {
        const operationId = op.progress?.operationId ?? null;
        if (operationId !== null) setActive((a) => (a === null || a.operationId !== null ? a : { ...a, operationId }));
        onOperation({ ...op, texts });
      },
    );
    setActive(null);
    onEnded(response);
    const result = isObject(response.result) ? response.result : {};
    const staged = typeof result.staged === "boolean" ? result.staged : null;
    // Spec FR-096: the fresh index read decides the merge tool result, never its exit or output.
    if (item === "mergetool" && staged !== null) return say(staged ? TEXTS.staged(path) : TEXTS.stays(path), staged ? TEXTS.staged(path) : TEXTS.stays(path));
    if (item !== "mergetool" && response.state === "succeeded") {
      const text = TEXTS.chosen(path, name ?? item);
      return say(text, text);
    }
    say(failureText(texts[0], response), null);
  }

  function cancelRun() {
    if (active === null || active.operationId === null || active.cancelRequested) return;
    setActive({ ...active, cancelRequested: true });
    void bridge.cancel({ operationId: active.operationId });
  }

  async function markResolved() {
    if (comparison === null || busy.current) return;
    busy.current = true;
    setLine(null);
    try {
      const result = await runFileAction({ ...props, comparison, category: "conflicted", onRefresh: props.onFileEnded, onOperation });
      if (result.state === "refused") say(result.text, null);
    } finally {
      busy.current = false;
    }
  }

  // FR-089 keeps the item in the view. The stage bar decision gives its reason before any request.
  const markReason: ReactNode = quiet ? RUNNING_REASON : comparison === null ? TEXTS.comparisonPending : decide({ ...props, comparison, category: "conflicted" }).reason;
  const toolReason = reasonOf("mergetool");
  const shownLine = line !== null && line.path === entry.pathBytes ? line.text : null;
  return (
    <section aria-label={TEXTS.region(entry.path)} data-slot="resolve-view" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-sm font-semibold break-all select-text">{entry.path}</h2>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {kind === null ? null : (
            <>
              <dt className="text-muted-text">{TEXTS.kind}</dt>
              <dd>{kind}</dd>
            </>
          )}
          <dt className="text-muted-text">{TEXTS.ours}</dt>
          <dd className="break-all">{nameOf(names?.ours) ?? (pending ? null : TEXTS.unknownName)}</dd>
          <dt className="text-muted-text">{TEXTS.theirs}</dt>
          <dd className="break-all">{nameOf(names?.theirs) ?? (pending ? null : TEXTS.unknownName)}</dd>
        </dl>
        {pending ? <p className="text-muted-text">{TEXTS.pending}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        {(["ours", "theirs"] as const).map((side) => (
          <ItemRow key={side} label={labelOf(side, names)} reason={reasonOf(side)} quiet={quiet} onRun={() => void start(side)} />
        ))}
        <ItemRow label={TEXTS.openTool} reason={toolReason} quiet={quiet} onRun={() => void start("mergetool")}>
          {tool === null ? null : <span className="text-muted-text">{TEXTS.toolNote(tool)}</span>}
        </ItemRow>
        {!quiet && value.mergetool?.reason === "no-merge-tool" ? (
          <Button variant="link" className="self-start" onClick={onOpenSettings}>
            {TEXTS.settings}
          </Button>
        ) : null}
        {active?.item === "mergetool" ? (
          <div className="flex items-center gap-2" data-slot="mergetool-running">
            <span>{TEXTS.toolRuns(active.tool ?? "")}</span>
            <Button variant="outline" disabled={active.operationId === null || active.cancelRequested} focusableWhenDisabled onClick={cancelRun}>
              {TEXTS.cancel}
            </Button>
          </div>
        ) : null}
        <ItemRow label={TEXTS.markResolved} reason={markReason} quiet={quiet} onRun={() => void markResolved()} />
      </div>
      <p role="status">{shownLine}</p>
      {confirm === null ? null : <ChooseConfirm path={entry.path} side={confirm.side} name={confirm.name} onCancel={() => setConfirm(null)} onConfirm={() => void run(confirm.side, confirm.token, confirm.name)} />}
    </section>
  );
}

/** Spec FR-091: the modal confirmation of 001 "Dialog sizes", with Cancel first (plan.md D15 "Confirm popover"). */
function ChooseConfirm({ path, side, name, onCancel, onConfirm }: { path: string; side: Side; name: string | null; onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} className="flex flex-col gap-2 sm:max-w-lg">
        <DialogTitle>{TEXTS.confirmTitle(side, name)}</DialogTitle>
        <p>{TEXTS.confirm(path, name ?? side)}</p>
        <div className="flex justify-end gap-2">
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            {TEXTS.cancel}
          </Button>
          <Button className="danger-button" onClick={onConfirm}>
            {TEXTS.verb(side)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
