// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitCommitIcon, RefreshIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Component, createContext, lazy, memo, Suspense, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { ChangeEntry, Comparison as ComparisonResult, Environment, RecoveryStatement, RegistrationResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import type { BridgeResponse, createBridge, OnProgress } from "../bridge";
import { ChangesPane as ChangesList, type FileAction, type FileActionResult } from "../changes/ChangesPane";
import { ComparisonView as Comparison, resultOf, showsDiff, type LineState } from "../changes/ComparisonView";
import { deleteBlock, fileActions } from "../changes/file-actions";
import { conflictedRows, countsText } from "../changes/file-tree";
import { FileControls, FileFailure, runFileAction } from "../changes/FileControls";
import { BLOCKED_TEXT, HunkButton, HunkControls, operationBlock, STALE_TEXT, type Blocked, type Eligibility, type ReasonPart, type StagingTarget } from "../changes/HunkControls";
import { CommitTray } from "../commit/CommitTray";
import { WorkingSummary } from "../commit/WorkingSummary";
import { IconButton } from "../components/icon-button";
import { TextTooltip } from "../components/text-tooltip";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "../components/ui/menubar";
import { CommitChanges, HISTORY_PANES } from "../history/CommitChanges";
import { DETAILS_WIDTH, ViewCommitDetails } from "../history/CommitDetails";
import { HistoryList, type HistoryListProps } from "../history/HistoryList";
import { branchName, INDEX_ROW, WORKING_ROW } from "../history/HistoryView";
import { createShortcutHandler, filterTarget, isEditable, nextSection, type Panel, type Section } from "../keyboard/shortcuts";
import { isObject } from "../lib/utils";
import {
  chooseProfile,
  clampPanes,
  commitViewProfile,
  dockBounds,
  historyFit,
  metrics,
  overflowScroll,
  paneBounds,
  sidebarBounds,
  statusAreaHeight,
  workAreaHeight,
  type Density,
  type Profile,
  type Size,
} from "../layout/profiles";
import { Splitter } from "../layout/Splitter";
import { ReferencesSidebar, type ReferencesSidebarProps } from "../refs/ReferencesSidebar";
import { createHistoryView, createInspection, refsChanged, type HistoryBridge, type HistoryView as HistoryStore } from "../state/history-view";
import { createRequests, isRegistration, wslDistro, type Clock, type RequestBridge, type Requests, type RequestState } from "../state/requests";
import { metrics as densityMetrics } from "../layout/profiles";
import { darkPaletteAttribute, DEFAULT_PREFERENCES, readPreferences, storePanes, writePreferences, type DarkPalette, type Panes, type Preferences, type Theme } from "../state/preferences";
import { createDrafts } from "../state/drafts";
import { createSpellEngine, type Spelling } from "../spelling/engine";
import { createSpellingStore } from "../spelling/store";
import { createDraftStore } from "../state/draft-store";
import { OperationStatus, SYNC_NAMES, type StatusOperation, type StatusRegionHandle } from "../status/OperationStatus";
import { SubmoduleNotice } from "../submodules/SubmoduleNotice";
import { INITIALIZE_FIRST, openSubmoduleReason, SubmodulesGroup, useSubmoduleUpdate } from "../submodules/SubmodulesGroup";
import { DiscardConfirm, IgnoreEditor } from "../ignore/IgnoreEditor";
import { ParentButton } from "./ParentButton";
import { needsTrust, type AskTrust } from "../trust/ask";
import { isTrustReport, READS_TRUST_TEXT, ReadsTrustNotice, SaveFailedNotice, showsChip, stoppedText, trustBeforeReview, TrustChip, trustFailureCode, COMMIT_TRUST_TEXT, type TrustReport } from "../trust/TrustChip";
import type { TrustAction } from "../../contracts/channel";
import { blockingText, hasRecoveryRow, NoticeBand } from "./NoticeBand";
import { MENU_CONTENT, MenuKey, RepositoryMenu } from "./RepositoryMenu";
import { codeText, COPY_FAILED_TEXT, failureText, CopyFailed, ErrorState, LimitedOutput, Loading, RepositoryRefused, SCOPE_LINE, StartPage, unknownReadText, WSL_START_CANCELED_TEXT, WslStarting, wslStartingText } from "./RepositoryStates";
import { folderName, RepositorySwitcher } from "./RepositorySwitcher";
import { hasMarkers, RecoveryMarkers } from "../boot/BootView";
import { COUNTS_TOOLTIP, isTrackingList, NO_BRANCH, trackingLabels, type TrackingEntry, type TrackLabel } from "../state/tracking";
import { ConflictConfirm, ConflictRow } from "../sync/ConflictActions";
import { ForcePushConfirm } from "../sync/ForcePushConfirm";
import { PullModeChoice } from "../sync/PullModeChoice";
import { pullAction, type DefaultPullAction } from "../sync/PullSplitButton";
import { PushNoticeRow } from "../sync/PushNoticeRow";
import { PushPanel } from "../sync/PushPanel";
import { CloneDialog } from "../clone/CloneDialog";
import { ConnectNoticeRow } from "../settings/ConnectTerminal";
import type { KeyProposal } from "../settings/SettingsDialog";
import { actionReason, quietReason, RECONCILING_REASON, RUNNING_REASON, syncReasons, SyncToolbar } from "../sync/SyncToolbar";
import { useSync } from "../sync/useSync";
import { suppressPageMenu } from "../components/action-menu";
import { DockRegion } from "../components/docked-panel";
import { IntegratePanel, type IntegrateRequest } from "../integrate/IntegratePanel";
import { ResolveView } from "../resolve/ResolveView";
import { Segmented } from "../components/segmented";
import { createIgnoreEditor, createWorkbench, type IgnoreEditor as IgnoreStore, type IgnoreTarget, type Parent, type View, type Workbench as WorkbenchStore } from "../state/workbench";
import { BranchButton } from "../branches/BranchButton";
import { useWorktreeActions } from "../worktrees/WorktreeActions";
import { WorktreeButton } from "../worktrees/WorktreeButton";
import { WorktreesGroup } from "../worktrees/WorktreesGroup";
import { W } from "../worktrees/texts";
import { useBranchActions } from "../branches/BranchActions";
import { CommitView } from "../views/CommitView";
import { HistoryView as HistoryFrame, HistoryListSlot } from "../views/HistoryView";
import { shortRef } from "../refs/ReferencesSidebar";

// plan.md "Chosen layout: one view", "Chosen layout, sizes, and DPI", "Dock region", "Keyboard and focus", and "Required visible states".

type Bridge = ReturnType<typeof createBridge>;
export type WorkbenchBridge = RequestBridge &
  HistoryBridge &
  Pick<
    Bridge,
    | "chooseRepository"
    | "readTrust"
    | "approveTrust"
    | "revokeTrust"
    | "getEnvironment"
    | "dismissRecoveryMarker"
    | "listRecentRepositories"
    | "openRecentRepository"
    | "removeRecentRepository"
    | "applyHunk"
    | "applyFile"
    | "reviewCommit"
    | "commit"
    | "getOperation"
    | "reviewSubmodules"
    | "updateSubmodules"
    | "readTracking"
    | "reviewSync"
    | "sync"
    | "readSyncSettings"
    | "readDictionary"
    | "listDictionaries"
    | "downloadDictionary"
    | "importDictionary"
    | "removeDictionary"
    | "setSpelling"
    | "openLicenceLink"
    | "setDefaultPullAction"
    | "clone"
    | "connectInTerminal"
    | "setSshClient"
    | "chooseSyncPath"
    | "clearSyncPath"
    | "launchPuttygen"
    | "readBranches"
    | "readWorktrees"
    | "applyFiles"
    | "reviewWorkbench"
    | "runWorkbench"
    | "openWorktree"
    | "revealPath"
    | "readGitSettings"
    | "setSwitchChoice"
    | "chooseWorktreeFolder"
    | "readCommitChanges"
    | "readCommitFile"
    | "readBlame"
    | "readIgnoreFile"
    | "previewIgnore"
    | "openSubmodule"
  >;
/** The hunk and file staging facts that the workbench gives the changes pane and the comparison view (T145, T202). */
export type Staging = {
  bridge: Pick<Bridge, "applyHunk" | "applyFile" | "applyFiles" | "reviewWorkbench" | "runWorkbench" | "revealPath" | "cancel">;
  /** The repository and the generation of the current capability, or null. */
  target: StagingTarget | null;
  blocked: Blocked;
  trust: TrustReport | null;
  eligibility: Eligibility | undefined;
  /** The description ID of the file button. Its text is a part of the T145 reason line. */
  fileReasonId: string;
  /** The file-action reason and the Stage key reason for the reason line. */
  reasons: ReasonPart[];
  onFileReason(text: string | null, quiet?: boolean): void;
  onPaneReason(text: string | null, quiet?: boolean): void;
  onOperation(op: StatusOperation): void;
  onEnded(operation: "applyHunk" | "applyFile", response: BridgeResponse): void;
  /** A file action that did not succeed, by the file `category:pathBytes`. */
  onFileFailed(file: string, response: BridgeResponse): void;
  /** The last failed file action. The comparison of that file shows its output below the heading. */
  fileFailure: { file: string; response: BridgeResponse } | null;
  /** A successful hunk action: the file as `category:pathBytes`, the ordinal of the acted hunk, and the patch that it replaced. */
  onHunkSucceeded(file: string, ordinal: number, patch: string): void;
  anchor: { file: string; ordinal: number; patch: string } | null;
  stepRef: RefObject<((direction: "next" | "previous") => void) | null>;
  /** A new object after each stage bar button success. */
  toolbarSuccess: { entryId: string } | null;
  onToolbarSuccess(entryId: string): void;
};
/** The props that the workbench gives each injected view. */
export type WorkbenchPaneProps = {
  state: RequestState;
  requests: Requests;
  density: Density;
  profile: Profile;
  textScale: number;
  menuOpen: boolean;
  modalOpen: boolean;
  /** Feeds the second live element of the status bar. Null clears it. */
  onStatus(text: string | null): void;
  /** The history list region minimum of `historyFit`. */
  historyListMin?: number;
  /** The selected history row: `WORKING_ROW`, `INDEX_ROW`, a commit OID, or null. */
  selected: string | null;
  /** The feature 002 history view of the open repository. */
  history: HistoryStore;
  /** The filter text box. Ctrl+F focuses it (feature 002 plan.md D6). */
  filterRef: RefObject<HTMLInputElement | null>;
  /** The Filter files field of the Commit view. Ctrl+F focuses it (feature 004 plan.md D15 keyboard map). */
  filesFilterRef?: RefObject<HTMLInputElement | null>;
  /** Docks the panel of a history row. It starts no Git read. */
  onSelectRow(id: string): void;
  /** Absent in a mount without staging controls. */
  staging?: Staging;
  /** Feature 003 FR-019: the count label of each local branch by name. */
  tracking?: ReadonlyMap<string, TrackLabel>;
  /** The feature 004 store (plan.md D15 "State"). */
  workbench: WorkbenchStore;
  /** Feature 004 spec FR-072: Trust… of a read that needs trust. */
  onTrustReads?(): void;
  /** Feature 004 plan.md D12 "Ask": the resolve actions ask at their first use. */
  askTrust?: AskTrust;
  /** The feature 004 branch actions (spec FR-014): the history labels and Create branch here on a history row. */
  branches?: ReturnType<typeof useBranchActions>;
  /** Feature 005 plan.md P8: the ignore editor, Blame, and Open submodule of the Commit view row menu. */
  commitActions?: CommitActions;
};
export type CommitActions = {
  ignore: IgnoreStore;
  onBlame(entry: ChangeEntry): void;
  onOpenSubmodule(path: string): void;
  submoduleReason(pathBytes: string): string | null;
};
export type WorkbenchProps = {
  bridge: WorkbenchBridge;
  ChangesPane: ComponentType<WorkbenchPaneProps>;
  ComparisonView: ComponentType<WorkbenchPaneProps>;
  HistoryView: ComponentType<WorkbenchPaneProps>;
  /** The `getEnvironment` result of the passed boot checks. */
  environment?: Environment | null;
  /** The `restoreWorkspace` response of the page start (contract §2). */
  restored?: Promise<BridgeResponse>;
  /** Gives each progress event of that restore to `listener`, starting with the latest one. */
  restoreProgress?(listener: OnProgress): void;
  /** Adds 1 after each `service-session` event (contract §2). */
  session?: number;
  /** Runs `chooseGit` and reads the environment again. It resolves with the `chooseGit` response. */
  onSelectGit?(): Promise<BridgeResponse>;
  /** Each `getEnvironment` response that the workbench reads again. */
  onEnvironment?(response: BridgeResponse): void;
  /** The Windows text scale factor (plan.md "Windows text size"). */
  textScale?: number;
  /** The draft memory (plan.md "Stored drafts"). The default stores a copy in IndexedDB. */
  drafts?: ReturnType<typeof createDrafts>;
  /** Feature 006 plan.md D15: the spelling store and engine of the window session. The default starts module workers. */
  spelling?: Spelling;
  /** The timers of the change poll. The default uses the browser timers. */
  clock?: Clock;
};

// plan.md "Required visible states", No file-action decision.
export const NO_DECISION = "This entry has no file-action decision";
export const NO_DECISION_PENDING = "Its comparison is still loading.";
// Feature 005 plan.md D11 and D15 "Submodules" texts.
const PARENT_LOST = "Open the parent repository with Open repository.";
const SUBMODULE_REASON: Record<string, (path: string) => string> = {
  "submodule-not-initialized": () => INITIALIZE_FIRST,
  "not-submodule": (path) => `Git lists no submodule at ${path}.`,
  path: () => "The submodule path holds a link, so Arbareto cannot open it.",
};
function submoduleRefusal(response: BridgeResponse, path: string): string {
  if (response.code === "BUSY") return "A Git operation is running in this repository. Wait for its result, then open the submodule.";
  const reason = (response.result as { reason?: unknown } | undefined)?.reason;
  const known = response.code === "SUBMODULE_UNAVAILABLE" && typeof reason === "string" ? SUBMODULE_REASON[reason] : undefined;
  return known?.(path) ?? `Open submodule did not complete: ${response.code ?? response.state}.`;
}
// plan.md "Required visible states", No selection.
export const DOCK_HINT = "Select the Working directory row to commit, or a commit to see its details.";
const NO_REPOSITORY = "No repository open";
// Feature 003 data-model §10: the Pull main part waits for `readSyncSettings`.
const SETTINGS_LOADING = "The default pull action is still loading…";
type SyncSettingsState = { action: DefaultPullAction | null; reason: string | null };
function settingsOf(response: BridgeResponse): SyncSettingsState {
  const action = isObject(response.result) ? response.result.defaultPullAction : undefined;
  if (response.state === "succeeded" && typeof action === "string") return { action: action as DefaultPullAction, reason: null };
  return { action: null, reason: response.state === "succeeded" ? unknownReadText("The default pull action") : `The default pull action did not load: ${response.code ?? response.state}.` };
}
// Plan.md D12 "Settings panel": a proposal is the last `remote.<name>.puttykeyfile` entry with a value (git-config(1): the last value wins).
function keyProposals(report: TrustReport | undefined): KeyProposal[] {
  const proposals = new Map<string, string>();
  for (const entry of report?.entries ?? []) {
    if (entry.value === undefined || !entry.key.startsWith("remote.") || !entry.key.endsWith(".puttykeyfile")) continue;
    const remote = entry.key.slice("remote.".length, -".puttykeyfile".length);
    if (remote !== "") proposals.set(remote, entry.value);
  }
  return [...proposals].map(([remote, path]) => ({ remote, path }));
}

// Feature 004 plan.md D15 top bar: the History and Commit segmented control.
const VIEW_OPTIONS = [
  { value: "history", label: "History", tooltip: "Show the History view." },
  { value: "commit", label: "Commit", tooltip: "Show the Commit view." },
] as const;

// plan.md "Dark palettes".
const DARK_PALETTES: { value: DarkPalette; label: string }[] = [
  { value: "graphite", label: "Graphite" },
  { value: "ink", label: "Ink" },
  { value: "warm", label: "Warm dark" },
];
const paletteLabel = (palette: DarkPalette) => DARK_PALETTES.find((p) => p.value === palette)!.label;
const DENSITIES: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
function storedPreferences(): Preferences {
  return typeof localStorage === "undefined" ? DEFAULT_PREFERENCES : readPreferences(localStorage);
}

function clientSize(): Size {
  return typeof window === "undefined" ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight };
}

function useClientSize(): Size {
  const [size, setSize] = useState(clientSize);
  useEffect(() => {
    const onResize = () => setSize(clientSize());
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** plan.md "Status and fallback texts": the toolbar branch text. */
// plan.md "Header layout": the WSL badge is 160 DIPs wide, times the text-size factor.
const WSL_BADGE_DIPS = 160;

/** "WSL: " stays whole, and a distro name that does not fit gets an end ellipsis. The full label stays the accessible name. */
function WslBadge({ distro, textScale }: { distro: string; textScale: number }) {
  return (
    <span data-slot="wsl-badge" className="badge badge-wsl shrink-0" style={{ width: WSL_BADGE_DIPS * textScale }}>
      <span className="sr-only">WSL: {distro}</span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">
        {"WSL: "}
      </span>
      <span aria-hidden="true" className="min-w-0 truncate">
        {distro}
      </span>
    </span>
  );
}

/** Feature 003 FR-019 to FR-022: the counts of the current branch. The hidden text repeats the tooltip, so a screen reader hears the last-fetch statement. */
function TrackingCount({ label, upstream }: { label: TrackLabel; upstream: string | null }) {
  if (label === null) return <span data-slot="tracking-count" className="num shrink-0" />;
  const full = `${label.label}${upstream ? `, ${shortRef(upstream)}` : ""}. ${COUNTS_TOOLTIP}`;
  return (
    <TextTooltip text={full}>
      <span data-slot="tracking-count" className="num shrink-0">
        <span aria-hidden="true">{label.text}</span>
        <span className="sr-only">{full}</span>
      </span>
    </TextTooltip>
  );
}

// plan.md "Measurements and budgets": a ready frame needs a complete read with `recoveryState` `ready`.
const completeRead = (workspace: WorkspaceSnapshot | null) => workspace !== null && workspace.completeness.state === "complete" && workspace.recoveryState === "ready";
const responseCode = (response: BridgeResponse) => (response.code ?? response.state) as ErrorCode;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The shown `Comparison` of the selected entry, and the staging target when the current capability binds that comparison (contract §8). */
function shownComparison(state: RequestState, staging: Staging | undefined) {
  const entryId = state.selection?.entryId;
  const entry = entryId === undefined ? null : (state.entries.find((e) => e.entryId === entryId) ?? null);
  const result = entry !== null && state.comparison?.entryId === entry.entryId ? resultOf(state.comparison) : null;
  const comparison = result !== null && "patch" in result ? (result as ComparisonResult) : null;
  const target = comparison !== null && staging?.target && state.capability?.comparisonId === comparison.comparisonId ? staging.target : null;
  return { entry, comparison, target };
}

/** The refusal reason of a file action without a `Comparison`: the typed code of the comparison read (contract §3, §9). */
function noDecisionText(state: RequestState): string {
  const response = state.comparison;
  const completeness = (response?.result as { completeness?: { code?: string } } | undefined)?.completeness;
  const code = completeness?.code ?? response?.code ?? response?.state;
  return code === undefined ? NO_DECISION_PENDING : `${NO_DECISION}: ${code}`;
}

/** The T133 changes pane on the T132 request state, with the T202 file controls in its stage bar. */
export function ChangesPaneMount({ state, requests, profile, density, textScale, menuOpen, modalOpen, onStatus, staging, workbench, onTrustReads, filesFilterRef, commitActions }: WorkbenchPaneProps) {
  const workspace = state.workspace;
  const key = state.repository?.worktreeKey ?? "";
  const view = useSyncExternalStore(
    (listener) => workbench?.subscribe(listener) ?? (() => {}),
    () => workbench?.commitView(key) ?? null,
  );
  const failureCode = state.readFailure === null ? null : responseCode(state.readFailure);
  // Contract §7: the read gate gives TRUST_REQUIRED or TRUST_CHANGED before any status read.
  const failure =
    failureCode === null ? null : needsTrust(state.readFailure!) && onTrustReads !== undefined ? (
      <ReadsTrustNotice onTrust={onTrustReads} />
    ) : (
      <ErrorState code={failureCode} result={state.readFailure!.result} onRefresh={requests.refresh} />
    );
  if (workspace === null) return failure ?? <Loading hasContent={false} refreshing={false} />;
  const selection = state.selection === null ? null : { entryId: state.selection.entryId, comparisonId: state.capability?.comparisonId ?? null };
  const shown = shownComparison(state, staging);
  const fileProps = (s: Staging, comparison: ComparisonResult, category: ChangeEntry["category"]) => ({
    bridge: s.bridge,
    target: shown.target,
    comparison,
    category,
    blocked: s.blocked,
    trust: s.trust,
    eligibility: s.eligibility,
    onRefresh: (response: BridgeResponse) => s.onEnded("applyFile", response),
    onFailed: (response: BridgeResponse) => s.onFileFailed(`${category}:${shown.entry!.pathBytes}`, response),
    onOperation: s.onOperation,
  });
  // The Space key acts only on the shown comparison that the pane names. Without a `Comparison`, no file-action decision exists.
  const onFileAction = async (action: FileAction): Promise<FileActionResult> => {
    const label = action.direction === "unstage" ? "Unstage file" : action.direction === "resolve" ? "Mark resolved" : "Stage file";
    if (staging !== undefined && shown.entry !== null && shown.comparison?.comparisonId === action.comparisonId) return runFileAction(fileProps(staging, shown.comparison, shown.entry.category));
    return { state: "refused", text: `${label} is unavailable: ${noDecisionText(state)}` };
  };
  const controls = staging !== undefined && shown.entry !== null && shown.comparison !== null ? fileProps(staging, shown.comparison, shown.entry.category) : null;
  // Feature 004 plan.md D8 and D15: the multi-file, ignore, and reveal actions bind the shown read.
  const running = staging?.blocked === "busy" || staging?.blocked === "running";
  const conflicts = state.entries.filter((e) => e.category === "conflicted").length;
  const files =
    staging === undefined || workbench === undefined || workbench === null
      ? undefined
      : {
          actions: fileActions({
            bridge: staging.bridge,
            target: state.repository === null ? null : { repositoryId: state.repository.repositoryId, repositoryGeneration: workspace.generation },
            snapshotId: workspace.snapshotId,
            entries: state.entries,
            onOperation: staging.onOperation,
            ended: workbench.ended,
            onStatus,
          }),
          reason: running ? RUNNING_REASON : staging.blocked !== null ? BLOCKED_TEXT[staging.blocked] : null,
          running,
          quiet: staging.blocked === "operation",
          cut: workspace.cut === "untracked",
          // Feature 005 plan.md D6: the 004 common refusals, then the 001 blocks of the shown read.
          deleteBlock: deleteBlock(workspace.operationState, conflicts) ?? (staging.blocked !== null && staging.blocked !== "operation" && staging.blocked !== "conflicted" ? BLOCKED_TEXT[staging.blocked] : null),
          wsl: workspace.location.kind === "wsl",
          unborn: workspace.head.state === "unborn",
          ...(commitActions === undefined
            ? {}
            : {
                onIgnore: (target: IgnoreTarget, line: string) => commitActions.ignore.open(target, line),
                onBlame: commitActions.onBlame,
                onOpenSubmodule: commitActions.onOpenSubmodule,
                submoduleReason: commitActions.submoduleReason,
              }),
        };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {failure}
      <LimitedOutput completeness={workspace.completeness} />
      <ChangesList
        entries={state.entries}
        selection={selection}
        onSelect={requests.selectEntry}
        onClearSelection={requests.clearSelection}
        filterRef={filesFilterRef}
        onFileAction={onFileAction}
        onReason={staging?.onPaneReason}
        onStatus={onStatus}
        menuOpen={menuOpen}
        modalOpen={modalOpen}
        fileActionRunning={staging?.blocked === "busy"}
        operationRunning={staging?.blocked === "busy" || staging?.blocked === "running"}
        toolbarSuccess={staging?.toolbarSuccess ?? null}
        complete={workspace.completeness.state === "complete"}
        sideBySide={profile !== "wide"}
        rowHeight={densityMetrics(density, textScale).row}
        layout={view?.layout}
        onLayout={view === null ? undefined : (layout) => workbench.setCommitView(key, { layout })}
        untrackedOpen={view?.untrackedOpen}
        onUntrackedOpen={view === null ? undefined : (untrackedOpen) => workbench.setCommitView(key, { untrackedOpen })}
        files={files}
        stageBar={
          staging === undefined ? undefined : controls === null ? null : (
            <FileControls
              key={controls.comparison.comparisonId}
              {...controls}
              reasonId={staging.fileReasonId}
              onReason={staging.onFileReason}
              onSuccess={() => staging.onToolbarSuccess(shown.entry!.entryId)}
            />
          )
        }
      />
    </div>
  );
}

// The Pierre worker pool. The Workbench mounts one keeper at the first diff of either view, because Pierre ends the pool when its last provider unmounts.
// The keeper sits outside the comparison view: a new parent above the view remounts it and drops its focus (T125).
const PatchPool = lazy(() => import("../changes/PatchPool"));

/** The T134 comparison view of the selected entry, with the T145 hunk controls in its heading. */
export function ComparisonViewMount({ state, requests, staging, workbench, onStatus, askTrust }: WorkbenchPaneProps) {
  const { entry, target, comparison } = shownComparison(state, staging);
  const response = entry !== null && state.comparison?.entryId === entry.entryId ? state.comparison : null;
  const file = entry === null ? null : `${entry.category}:${entry.pathBytes}`;
  const anchor = staging?.anchor?.file === file ? staging.anchor : null;
  // A refusal of a hunk's own button shows in the reason line of the hunk controls until the comparison changes.
  const [hunkNotice, setHunkNotice] = useState<{ comparisonId: string; text: string } | null>(null);
  const hunkNoticeId = useId();
  const controls =
    staging === undefined || entry === null
      ? undefined
      : (comparison: ComparisonResult, displayFailed: boolean, lines?: LineState) => (
          <HunkControls
            key={comparison.comparisonId}
            bridge={staging.bridge}
            target={target}
            comparison={comparison}
            category={entry.category}
            selectedHunk={state.selectedHunk}
            // plan.md "Task flow and command placement": the surviving hunk with the same ordinal, or the last hunk when fewer remain.
            anchoredHunk={anchor !== null && anchor.patch !== comparison.patch ? (comparison.hunks[Math.min(anchor.ordinal, comparison.hunks.length - 1)]?.hunkId ?? null) : null}
            onSelectHunk={requests.selectHunk}
            blocked={staging.blocked}
            trust={staging.trust}
            eligibility={staging.eligibility}
            displayFailed={displayFailed}
            reasons={[...staging.reasons, { id: hunkNoticeId, text: hunkNotice?.comparisonId === comparison.comparisonId ? hunkNotice.text : null }]}
            onOperation={staging.onOperation}
            onEnded={(response, ordinal) => {
              if (response.state === "succeeded") staging.onHunkSucceeded(file!, ordinal, comparison.patch);
              staging.onEnded("applyHunk", response);
            }}
            stepRef={staging.stepRef}
            lines={lines}
          />
        );
  // Spec FR-037: the Stage hunk or Unstage hunk button on each hunk.
  const hunkAction =
    staging === undefined || entry === null
      ? undefined
      : (comparison: ComparisonResult, displayFailed: boolean, index: number) => (
          <HunkButton
            bridge={staging.bridge}
            target={target}
            comparison={comparison}
            category={entry.category}
            selectedHunk={state.selectedHunk}
            anchoredHunk={null}
            onSelectHunk={requests.selectHunk}
            blocked={staging.blocked}
            trust={staging.trust}
            eligibility={staging.eligibility}
            displayFailed={displayFailed}
            onOperation={staging.onOperation}
            onEnded={(response, ordinal) => {
              if (response.state === "succeeded") staging.onHunkSucceeded(file!, ordinal, comparison.patch);
              setHunkNotice(response.code === "STALE_SELECTION" ? { comparisonId: comparison.comparisonId, text: STALE_TEXT } : null);
              staging.onEnded("applyHunk", response);
            }}
            index={index}
          />
        );
  const failed = staging?.fileFailure?.file === file ? staging.fileFailure.response : null;
  const diff = (
    <Comparison
      entry={entry}
      response={response}
      selectedHunk={state.selectedHunk}
      onRefresh={requests.refresh}
      controls={controls}
      hunkAction={hunkAction}
      anchor={anchor}
      notice={failed === null ? undefined : <FileFailure response={failed} />}
    />
  );
  // Feature 004 plan.md D15 "P2 regions": the resolve view replaces the diff of a selected Conflicted entry.
  const view =
    entry?.category === "conflicted" && staging !== undefined && state.workspace !== null ? (
      <ResolveView
        entry={entry}
        snapshotId={state.workspace.snapshotId}
        comparison={comparison}
        bridge={staging.bridge}
        target={staging.target}
        blocked={staging.blocked}
        trust={staging.trust}
        eligibility={staging.eligibility}
        askTrust={askTrust}
        onOperation={staging.onOperation}
        onEnded={(response) => workbench.ended("runWorkbench", response)}
        onFileEnded={(response) => staging.onEnded("applyFile", response)}
        onStatus={onStatus}
        onOpenSettings={() => workbench.setView(state.repository?.worktreeKey ?? "", "settings", { page: "Editor and tools" })}
      />
    ) : (
      diff
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{view}</div>
    </div>
  );
}

/** The feature 002 history list with the Working directory and Index rows (plan.md D6). */
export function HistoryViewMount({ state, history, density, profile, textScale, onSelectRow, filterRef, tracking, branches }: WorkbenchPaneProps) {
  const entries = state.workspace?.completeness.state === "complete" ? state.entries : null;
  const onScope = useLatest((scope: Parameters<HistoryListProps["onScope"]>[0]) => void history.setScope(scope));
  const onLabelMenu = useLatest((label: Parameters<NonNullable<HistoryListProps["onLabelMenu"]>>[0], anchor: HTMLElement, byKey?: boolean) => branches?.onRef(label.kind as "branch" | "remote", label.name, "menu", anchor, byKey));
  const onCreateBranch = useLatest((oid: string, anchor: HTMLElement) => branches?.create(oid, anchor));
  return (
    <HistoryListMemo
      unread={state.readFailure !== null && needsTrust(state.readFailure) ? READS_TRUST_TEXT : null}
      view={history}
      entries={entries}
      density={density}
      profile={profile}
      textScale={textScale}
      onSelect={onSelectRow}
      onScope={onScope}
      filterRef={filterRef}
      tracking={tracking}
      onLabelMenu={branches === undefined ? undefined : onLabelMenu}
      onCreateBranch={branches === undefined ? undefined : onCreateBranch}
    />
  );
}
// A running operation renders the Workbench. These regions read no operation state, so they render only on their own prop changes (spec SC-009).
const HistoryListMemo = memo(HistoryList);
const ReferencesSidebarMemo = memo(ReferencesSidebar);
const IgnoreEditorMemo = memo(IgnoreEditor);
// The sidebar groups after the references read operation state. A context feeds them, so the memo sidebar can skip its render.
const SidebarAfter = createContext<ReactNode>(null);
const SidebarAfterSlot = () => useContext(SidebarAfter);
const SIDEBAR_AFTER = <SidebarAfterSlot />;

/** A callback with a fixed identity that calls the newest `run`. Call it only from events and effects. */
function useLatest<A extends unknown[], R>(run: (...args: A) => R): (...args: A) => R {
  const latest = useRef(run);
  latest.current = run;
  const [stable] = useState(() => (...args: A) => latest.current(...args));
  return stable;
}

/** plan.md "Status area": the Git version at the right end of the status bar, outside every live region, and the "Unqualified platform" label when it applies. */
export function GitSegment({ version, distro, scope }: { version: string; distro: string | null; scope: Environment["platformScope"] | undefined }) {
  return (
    <span data-slot="git-version" className="flex shrink-0 items-center gap-2 text-muted-text">
      {distro === null ? `Git ${version}` : `Git ${version} (WSL: ${distro})`}
      {scope === "other" ? <span className="badge border-control-border">Unqualified platform</span> : null}
    </span>
  );
}


/** The docked panel of a history row. */
const panelOf = (selected: string | null): Panel | null => (selected === null ? null : selected === WORKING_ROW || selected === INDEX_ROW ? "commit" : "details");

// plan.md "Keyboard and focus", Pane navigation: each section element carries its name.
const SECTION_SELECTOR = "[data-section]";
const TABBABLE = 'input:not([disabled]), button:not([disabled]), textarea, [tabindex="0"], [role="option"][tabindex="0"]';
// Plan D15 "F6 order per view": the Tab-stop row of a file list.
const FILE_TAB_STOP = '[data-file-tree] [role="treeitem"][tabindex="0"]';

// The About dialog and the notices load on first open (plan.md "Startup chunk budget").
const AboutMount = lazy(() => import("../about/AboutMount"));
// The Settings view and its pages load on first open (plan.md "Startup chunk budget").
const SettingsView = lazy(() => import("../settings/SettingsView").then((m) => ({ default: m.SettingsView })));

// plan.md "Required visible states", About failed. `NOTICES_MISSING` comes from `AboutMount`. Any other failure, such as a chunk that did not load, is `LOAD_FAILED`.

/** Shows the About failure in a dialog, so the window never goes blank. */
class AboutBoundary extends Component<{ onClose(): void; children: ReactNode }, { code: string | null }> {
  state = { code: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { code: (error as { code?: unknown } | null)?.code === "NOTICES_MISSING" ? "NOTICES_MISSING" : "LOAD_FAILED" };
  }
  render() {
    if (this.state.code === null) return this.props.children;
    return (
      <Dialog open onOpenChange={(open) => !open && this.props.onClose()}>
        <DialogContent showCloseButton={false} className="flex flex-col gap-2">
          <DialogTitle>About Arbareto</DialogTitle>
          <p role="alert">
            {codeText("About Arbareto did not load: ", this.state.code)}
          </p>
          <Button variant="outline" className="self-end" onClick={this.props.onClose}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    );
  }
}

export function Workbench({ bridge, ChangesPane, ComparisonView, HistoryView, environment: given = null, restored, restoreProgress, session = 0, onSelectGit, onEnvironment, textScale = 1, drafts: givenDrafts, spelling: givenSpelling, clock }: WorkbenchProps) {
  // plan.md "Required visible states", Recovery statement: the statement stays until the next `refresh: true` read or another repository.
  const [recovery, setRecovery] = useState<{ repositoryId: string; statement: RecoveryStatement } | null>(null);
  // Contract §11 "Distro start": a registration, restore, or marker dismissal in phase `wsl-starting`, until its response. No event marks the probe end.
  // Contract §11 defines Cancel only for a registration or restore, so a dismissal start has no Cancel.
  const [starting, setStarting] = useState<{ distro: string; operationId: string; cancelable: boolean } | null>(null);
  // The operation that the WslStarting Cancel canceled.
  const canceledStart = useRef<string | null>(null);
  const onStart: OnProgress = (event) => {
    if (event.phase === "wsl-starting" && event.distro !== undefined) setStarting({ distro: event.distro, operationId: event.operationId, cancelable: true });
  };
  const endStart = (response: BridgeResponse) => {
    setStarting((current) => (current !== null && current.operationId === response.operationId ? null : current));
    if (response.state === "canceled" && response.operationId !== undefined && response.operationId === canceledStart.current) setNotice(WSL_START_CANCELED_TEXT);
    return response;
  };
  const [{ requests, historyView, store, inspection, ignore }] = useState(() => {
    // The two stores refer to each other: the requests open the view, and the view's `openHistory` counts as a workspace read.
    let view: HistoryStore | null = null;
    const requests = createRequests({
      clock,
      history: { open: () => void view!.open(view!.getState().scope, false), refresh: () => void view!.refresh(), openedSeq: () => view!.getState().openedSeq },
      bridge: {
        restoreWorkspace: () => bridge.restoreWorkspace(onStart).then(endStart),
        readEntries: (target, payload) => bridge.readEntries(target, payload),
        readRefs: (target) => bridge.readRefs(target),
        readComparison: (target, payload) => bridge.readComparison(target, payload),
        cancel: (payload) => bridge.cancel(payload),
        // Contract §3: only a `refresh: true` read carries `recovery`.
        readWorkspace: (target, payload, onProgress) =>
          bridge.readWorkspace(target, payload, onProgress).then((response) => {
            const statement = (response.result as Partial<WorkspaceSnapshot> | undefined)?.recovery;
            if (payload.refresh) setRecovery(statement === undefined ? null : { repositoryId: target.repositoryId, statement });
            return response;
          }),
      },
    });
    view = createHistoryView(
      {
        openHistory: (target, payload, onProgress) => requests.track(bridge.openHistory(target, payload, onProgress)),
        loadHistory: (target, payload, onProgress) => bridge.loadHistory(target, payload, onProgress),
        readHistoryRows: (target, payload, onProgress) => bridge.readHistoryRows(target, payload, onProgress),
        searchHistory: (target, payload, onProgress) => bridge.searchHistory(target, payload, onProgress),
        closeHistory: (target, payload, onProgress) => bridge.closeHistory(target, payload, onProgress),
        cancel: (payload) => bridge.cancel(payload),
      },
      // The view opens only while a repository is open (`createRequests` `history.open`).
      () => requests.target()!,
    );
    const store = createWorkbench({
      bridge: { readBranches: (target, onProgress) => bridge.readBranches(target, onProgress) },
      target: requests.target,
      mutationEnded: requests.mutationEnded,
      refreshHistory: () => void view!.refresh(),
    });
    // Feature 005 plan.md D15 "State": the commit changes, the selected file, the parent index, and the blame.
    const inspection = createInspection(
      {
        readCommitChanges: (target, payload, onProgress) => bridge.readCommitChanges(target, payload, onProgress),
        readCommitFile: (target, payload, onProgress) => bridge.readCommitFile(target, payload, onProgress),
        readBlame: (target, payload, onProgress) => bridge.readBlame(target, payload, onProgress),
        cancel: (payload) => bridge.cancel(payload),
      },
      () => requests.target()!,
    );
    // Feature 005 plan.md D15 "State": the ignore editor of the Commit view.
    const ignore = createIgnoreEditor({
      bridge: {
        readIgnoreFile: (target, payload, onProgress) => bridge.readIgnoreFile(target, payload, onProgress),
        previewIgnore: (target, payload, onProgress) => bridge.previewIgnore(target, payload, onProgress),
        reviewWorkbench: (target, payload, onProgress) => bridge.reviewWorkbench(target, payload, onProgress),
        runWorkbench: (target, payload, onProgress) => bridge.runWorkbench(target, payload, onProgress),
        cancel: (payload) => bridge.cancel(payload),
      },
      target: requests.target,
      snapshotId: () => requests.state().workspace?.snapshotId ?? null,
      onOperation: (op) => reportOperation.current(op),
      ended: (response) => store.ended("runWorkbench", response),
    });
    return { requests, historyView: view, store, inspection, ignore };
  });
  const reportOperation = useRef<(op: StatusOperation) => void>(() => {});
  // The latest environment: the given one, or a later read after a dismissal or a `service-session` event.
  const [environment, setEnvironment] = useState(given);
  useEffect(() => setEnvironment(given), [given]);
  async function readEnvironment() {
    const response = await bridge.getEnvironment();
    if (response.state === "succeeded") setEnvironment(response.result as Environment);
    onEnvironment?.(response);
  }
  // Contract §6 "Dismissal": the outcome stays unknown, and the next environment read shows the remaining markers.
  // The start state of a dismissal ends with the response of that dismissal.
  async function dismissMarker(markerId: string) {
    let operationId: string | null = null;
    await bridge.dismissRecoveryMarker({ markerId }, (event) => {
      if (event.phase !== "wsl-starting" || event.distro === undefined) return;
      operationId = event.operationId;
      setStarting({ distro: event.distro, operationId, cancelable: false });
    });
    setStarting((current) => (current !== null && current.operationId === operationId ? null : current));
    await readEnvironment();
  }
  const state = useSyncExternalStore(requests.subscribe, requests.state, requests.state);
  const historyState = useSyncExternalStore(historyView.subscribe, historyView.getState, historyView.getState);
  const blameOpen = useSyncExternalStore(inspection.subscribe, () => inspection.getState().blame !== null, () => inspection.getState().blame !== null);
  const historyPatchShown = () => {
    const file = inspection.getState().file;
    return file?.state === "loaded" && file.result.patch !== null;
  };
  const lineOid = useSyncExternalStore(inspection.subscribe, inspection.lineCommit, inspection.lineCommit);
  // @pierre/diffs 1.5.1 WorkerPoolContext.js: the providers share one worker pool, and the last provider that unmounts ends it.
  // From the first diff of either view on, one hidden provider keeps the pool for the session.
  const historyPatch = useSyncExternalStore(inspection.subscribe, historyPatchShown, historyPatchShown);
  const [keepPool, setKeepPool] = useState(false);
  if (!keepPool && (historyPatch || showsDiff(resultOf(state.comparison)))) setKeepPool(true);
  // Data-model §14: the view of each worktree for the window session. Without a repository, the empty key holds the view.
  const viewKey = state.repository?.worktreeKey ?? "";
  const view: View = useSyncExternalStore(store.subscribe, () => store.view(viewKey), () => store.view(viewKey));
  const commitState = useSyncExternalStore(store.subscribe, () => store.commitView(viewKey), () => store.commitView(viewKey));
  const parents = useSyncExternalStore(store.subscribe, () => store.getState().parents, () => store.getState().parents);
  const ignoreState = useSyncExternalStore(ignore.subscribe, ignore.getState, ignore.getState);
  const filterRef = useRef<HTMLInputElement>(null);
  const filesFilterRef = useRef<HTMLInputElement>(null);
  // Feature 005 plan.md D15 keyboard map: Ctrl+F focuses Filter files while the focus is in Changed files or in the History diff.
  const historyFilesRef = useRef<HTMLInputElement>(null);
  // The details width and the Changed files width and layout stay while the blame view replaces the dock content.
  const [historyPanes, setHistoryPanes] = useState({ details: DETAILS_WIDTH, ...HISTORY_PANES });
  const [preferences, setPreferences] = useState(storedPreferences);
  const client = useClientSize();
  const profile: Profile = chooseProfile(client, textScale, preferences.density);
  const m = metrics(preferences.density, textScale);
  // A drag shows its live sizes here and stores them once, at its end. plan.md "Dock region": one remembered height for each panel.
  const [dragPanes, setDragPanes] = useState<Partial<Panes>>({});
  const panes = { ...preferences.panes, ...dragPanes };
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherInstant, setSwitcherInstant] = useState(false);
  // A refused `chooseRepository` or `restoreWorkspace`. The workspace stays unchanged.
  const [refusal, setRefusal] = useState<BridgeResponse | null>(null);
  const [restoring, setRestoring] = useState(restored !== undefined);
  const [trust, setTrust] = useState<{ report: TrustReport } | null>(null);
  const [trustRead, setTrustRead] = useState(0);
  // Feature 004 spec FR-069 and FR-072: the action that Not now blocked. The registration asks no second time.
  const [declined, setDeclined] = useState<TrustAction | null>(null);
  const declinedNow = useRef(declined);
  declinedNow.current = declined;
  // A trust failure or a copy failure. It shows in the first live element of the status bar until the next notice or repository.
  const [notice, setNotice] = useState<ReactNode>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [paneStatus, setPaneStatus] = useState<string | null>(null);
  // The selected history row. A repository open clears it (FR-034), and a refresh keeps a commit while the new page holds it.
  const [row, setRow] = useState<{ repository: RequestState["repository"]; id: string | null; epoch: number }>({ repository: state.repository, id: null, epoch: 0 });
  // Feature 003 plan.md D12: the clone panel replaces the main area until it closes. The settings panel is the 004 Settings view (plan.md D15, O-7).
  const [mainPanel, setMainPanel] = useState<"clone" | null>(null);
  // Feature 004 plan.md D15 "Docked panel": the Merge or Rebase panel of one worktree. The WP12 branch menu calls `openIntegrate`.
  const [integrate, setIntegrate] = useState<{ key: string; request: IntegrateRequest; opener: Element | null } | null>(null);
  const openIntegrate = (request: IntegrateRequest, opener: Element | null) => {
    worktrees.closeAdd();
    setIntegrate({ key: viewKey, request, opener });
  };
  const openSettings = () => {
    setMainPanel(null);
    store.setView(viewKey, "settings");
  };
  // Feature 003 FR-034 and data-model §11: the `sync` with a kept connect target that the connect row offers, with its repository.
  const [connect, setConnect] = useState<{ repositoryId: string; operationId: string; name: string } | null>(null);
  // Feature 003 FR-004, FR-013, FR-040, and contract Δ8: the reads after each `sync` outcome. A new view keeps the selected commit and shows no refs-changed notice.
  const sync = useSync({
    bridge,
    askTrust,
    target: requests.target,
    repositoryId: state.repository?.repositoryId ?? null,
    headTarget: state.workspace === null ? undefined : state.workspace.head.state === "detached" ? null : state.workspace.head.target,
    headOid: state.workspace === null ? undefined : state.workspace.head.state === "unborn" ? null : state.workspace.head.oid,
    onOperation: (op) => {
      setOperation(op);
      const response = op.response;
      const id = state.repository?.repositoryId;
      if (response === null) return setConnect(null);
      if (isObject(response.result) && response.result.connectTarget === true && op.sync !== undefined && response.operationId !== undefined && id !== undefined) {
        setConnect({ repositoryId: id, operationId: response.operationId, name: SYNC_NAMES[op.sync.action] });
      }
    },
    onRefused: (text) => setNotice(text),
    onEnded: (response) => {
      void historyView.refresh();
      onEnded("sync", response);
      readTracking();
    },
  });
  const pushNoticeShown = sync.notice !== null;
  const modalOpen = sync.confirm !== null || sync.conflictConfirm !== null;
  const switcher = useRef<HTMLDivElement>(null);
  const menubar = useRef<HTMLDivElement>(null);
  const beforeMenu = useRef<HTMLElement | null>(null);
  const sections = useRef<HTMLDivElement>(null);
  const lastFocus = useRef(new Map<Section, HTMLElement>());
  const [drafts] = useState(() => givenDrafts ?? createDrafts(createDraftStore()));
  const [[spelling, ownsSpelling]] = useState<[Spelling, boolean]>(() => {
    if (givenSpelling !== undefined) return [givenSpelling, false];
    const store = createSpellingStore();
    return [{ store, engine: createSpellEngine(store, { bridge }) }, true];
  });
  // main.tsx mounts a new Workbench after an environment failure, so an engine that this one made ends its workers here.
  useEffect(() => (ownsSpelling ? () => spelling.engine.dispose() : undefined), [spelling, ownsSpelling]);
  // The latest mutation of this repository for the status region (T138). Another repository clears it.
  const [operation, setOperation] = useState<StatusOperation | null>(null);
  reportOperation.current = setOperation;
  // Feature 003 data-model §1: the newest `readTracking` entries of the open repository.
  // `code` is the response code or state of a failed read, null after a success.
  const [tracking, setTracking] = useState<{ repositoryId: string; entries: TrackingEntry[] | null; failure: string | null } | null>(null);
  const trackingSeq = useRef(0);
  const [syncSettings, setSyncSettings] = useState<SyncSettingsState>({ action: null, reason: SETTINGS_LOADING });
  const [anchor, setAnchor] = useState<Staging["anchor"]>(null);
  // `quiet`: the text stays the hidden description of its control (spec FR-105).
  const [fileReason, setFileReason] = useState<{ text: string | null; quiet: boolean }>({ text: null, quiet: false });
  const [paneReason, setPaneReason] = useState<{ text: string | null; quiet: boolean }>({ text: null, quiet: false });
  const [toolbarSuccess, setToolbarSuccess] = useState<{ entryId: string } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [fileFailure, setFileFailure] = useState<Staging["fileFailure"]>(null);
  const fileReasonId = useId();
  const paneReasonId = useId();
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const stepRef = useRef<((direction: "next" | "previous") => void) | null>(null);
  const messageField = useRef<HTMLTextAreaElement | null>(null);
  const commitPanelRef = useRef<HTMLDivElement>(null);
  const comparisonPane = useRef<HTMLDivElement>(null);
  const statusRegion = useRef<StatusRegionHandle>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const noticeButton = useRef<HTMLButtonElement | null>(null);
  // React detaches a ref before it removes the node, so the focus test sees the button that leaves.
  const bandFocusLost = useRef(false);
  const [bindNoticeButton] = useState(() => (element: HTMLButtonElement) => {
    noticeButton.current = element;
    return () => {
      if (document.activeElement === element) bandFocusLost.current = true;
      noticeButton.current = null;
    };
  });
  // plan.md "Notice band": a band control that leaves with focus moves focus to the band heading.
  const [bindBandControl] = useState(() => (element: HTMLButtonElement) => () => {
    if (document.activeElement === element) bandFocusLost.current = true;
  });
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  const referencesSection = useRef<HTMLDivElement>(null);
  // The constrained references section starts collapsed. The toggle state lasts for the window session (001 plan.md "References sidebar").
  const [referencesShown, setReferencesShown] = useState(false);
  // The opener of the submodule update. The Submodules group keeps the focused control.
  const reviewOpener = useRef<"notice" | "menu" | "group">("notice");
  // After an approval, `approvalRead` waits until the read that `trustApproved` starts ends with any result,
  // so the commit review names the snapshot after the approval (contract §3).
  const approvalRead = useRef<((approved: boolean) => void) | null>(null);
  const approving = useRef(false);
  // The approval resolves after the commit that follows the read end, so the tray reads the props of that render.
  const [approvalEnds, setApprovalEnds] = useState(0);
  useEffect(() => {
    approvalRead.current?.(true);
    approvalRead.current = null;
  }, [approvalEnds]);

  // An empty repository after Refresh selects no commit, so the dock shows its hint.
  const kept = row.repository === state.repository && historyState.selection !== null ? row.id : null;
  // The row epoch whose details read returned. The Details-ready mark waits for it.
  const [detailsRead, setDetailsRead] = useState(-1);
  if (row.repository !== state.repository) setRow({ repository: state.repository, id: null, epoch: row.epoch });
  const panel = panelOf(kept);
  // A row selection docks its panel at once (plan.md "Change the docked panel"). The history list reports each new selection once.
  const onSelectRow = useLatest((id: string) => setRow((r) => (r.repository === state.repository && r.id === id ? r : { repository: state.repository, id, epoch: r.epoch + 1 })));
  // A Refresh also lists the submodule rows again after its read (spec FR-077).
  const refresh = useLatest(() => {
    submoduleUpdate.refreshed();
    requests.refresh();
  });
  const selectCommit = useLatest((oid: string) => historyView.selectOid(oid));
  const showBranchHistory = useLatest(() => void historyView.setScope("current"));
  const trustReads = useLatest(() => void approveTrust("read"));
  const referencesElement = useLatest(() => referencesSection.current);
  const onBranchAction = useLatest((...[entry, action, anchor, byKey]: Parameters<NonNullable<ReferencesSidebarProps["onBranchAction"]>>) => branches.onRef(entry.kind as "branch" | "remote", entry.name, action, anchor, byKey));

  const statusStop = operation !== null || starting !== null;
  // Plan.md D15 F6 order: each view has its own order.
  const sectionPanel: Panel | null = view === "commit" ? "commit" : view === "settings" ? "settings" : panel;
  const live = useRef({ requests, menuOpen, modalOpen, switcherOpen, repository: state.repository, panel: sectionPanel, statusStop, starting: starting !== null, view });
  live.current = { requests, menuOpen, modalOpen, switcherOpen, repository: state.repository, panel: sectionPanel, statusStop, starting: starting !== null, view };

  useEffect(() => {
    window.addEventListener("contextmenu", suppressPageMenu);
    return () => window.removeEventListener("contextmenu", suppressPageMenu);
  }, []);

  useEffect(
    () => () => {
      // The view closes first, while the requests still name its repository.
      historyView.close();
      requests.dispose();
    },
    [requests, historyView],
  );

  /** Feature 005 data-model §9: `parents` is the parent chain after this open. Every other open clears it. */
  function registered(response: BridgeResponse, parents: readonly Parent[] = []) {
    // Contract §3: a canceled dialog, or no stored last repository, keeps the workspace.
    if (response.state === "canceled") return;
    if (response.state === "succeeded" && isRegistration(response.result)) {
      store.setParents(parents);
      setRefusal(null);
      setSaveFailed(false);
      setRecovery(null);
      requests.open(response.result);
    } else setRefusal(response);
  }

  useEffect(() => restoreProgress?.(onStart), [restoreProgress]);
  useEffect(() => {
    if (restored === undefined) return;
    let current = true;
    void restored.then((response) => {
      if (!current) return;
      setRestoring(false);
      endStart(response);
      // A repository that the user opened during the restore wins.
      if (requests.state().repository === null) registered(response);
    });
    return () => void (current = false);
  }, [restored, requests]);

  // Contract §2: after each `service-session` event, the page runs `restoreWorkspace` again.
  const firstSession = useRef(session);
  useEffect(() => {
    if (session === firstSession.current) return;
    // Feature 002 contract Δ8: after a service restart no view resumes. Refresh opens a new one.
    historyView.markStale();
    requests.serviceSession();
    void readEnvironment();
  }, [session, requests]);

  // Feature 004 plan.md D12: the trust read feeds the status bar chip and the inline reasons. It never prompts.
  const repositoryId = state.repository?.repositoryId ?? null;
  useEffect(() => {
    setTrust(null);
    setNotice(null);
    // A service session also passes here: `requests.serviceSession` clears the repository first (requests.ts `serviceSession`).
    setDeclined(null);
    inspection.reset();
    ignore.reset();
  }, [repositoryId]);
  useEffect(() => {
    if (repositoryId === null) return;
    let current = true;
    void bridge.readTrust({ repositoryId }).then((response) => {
      if (!current) return;
      // 004 plan.md D15: a `limited` read carries the full report with `inputLimited`, so the chip shows "Not trusted".
      if ((response.state !== "succeeded" && response.state !== "limited") || !isTrustReport(response.result)) return setNotice(failureText("Trust review", response, trustFailureCode(response)));
      setTrust({ report: response.result });
    });
    return () => void (current = false);
  }, [bridge, repositoryId, trustRead]);

  // plan.md "Required visible states", Succeeded: the outcome text stays until another repository opens. A service session keeps it.
  useEffect(() => {
    setOperation(null);
    setAnchor(null);
    setFileFailure(null);
    approvalRead.current?.(false);
    approvalRead.current = null;
  }, [repositoryId]);

  // Feature 003 plan.md D8: one `readTracking`. Only the newest response counts.
  function readTracking() {
    const target = requests.target();
    if (target === null) return;
    const seq = ++trackingSeq.current;
    void bridge.readTracking(target).then((response) => {
      if (seq !== trackingSeq.current) return;
      const list = response.state === "succeeded" && isTrackingList(response.result) ? response.result : null;
      const failure = list !== null ? null : response.state === "succeeded" ? unknownReadText("Counts") : `Counts did not load: ${response.code ?? response.state}.`;
      setTracking({ repositoryId: target.repositoryId, entries: list?.entries ?? null, failure });
    });
  }
  // Plan.md D8 triggers: each new `readRefs.refsDigest` and each focus return. Each sync outcome runs one too.
  const refsDigest = state.refs?.refsDigest ?? null;
  useEffect(() => {
    if (refsDigest !== null) readTracking();
  }, [repositoryId, refsDigest]);
  useEffect(() => {
    if (repositoryId === null) return;
    const onFocus = () => readTracking();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repositoryId]);
  // Data-model §10: the shell keeps the default pull action.
  useEffect(() => {
    if (repositoryId === null) return;
    let current = true;
    const read = bridge.readSyncSettings();
    // Feature 006 data-model §8: the same result carries the spelling selection.
    spelling.store.settings(read);
    void read.then((response) => void (current && setSyncSettings(settingsOf(response))));
    return () => void (current = false);
  }, [bridge, repositoryId, spelling]);
  async function setDefaultPullAction(action: DefaultPullAction) {
    const response = await bridge.setDefaultPullAction({ action });
    if (response.state === "succeeded") setSyncSettings(settingsOf(response));
    else setNotice(codeText("Set default action did not complete: ", response.code ?? response.state));
  }

  // plan.md "Stored drafts": after each registration result, the page reads the stored draft of that worktree.
  const worktreeKey = state.repository?.worktreeKey ?? null;
  useEffect(() => {
    if (worktreeKey !== null) void drafts.restore(worktreeKey);
  }, [drafts, worktreeKey]);

  // index.css: an absent `data-theme` means System, and an absent `data-density` means Compact.
  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", preferences.theme);
    if (preferences.density === "compact") root.removeAttribute("data-density");
    else root.setAttribute("data-density", preferences.density);
    const palette = darkPaletteAttribute(preferences.darkPalette);
    if (palette === null) root.removeAttribute("data-dark-palette");
    else root.setAttribute("data-dark-palette", palette);
  }, [preferences.theme, preferences.density, preferences.darkPalette]);

  const savePreferences = (next: Preferences) => {
    setPreferences(next);
    if (typeof localStorage !== "undefined") writePreferences(localStorage, next);
  };
  const resize = (key: keyof Panes) => (value: number) => setDragPanes((l) => ({ ...l, [key]: value }));
  const keepPane = (key: keyof Panes) => (value: number) => {
    setDragPanes({});
    setPreferences(storePanes(typeof localStorage === "undefined" ? null : localStorage, preferences, profile, { [key]: value }));
  };

  const workspace = state.workspace;
  const path = workspace?.identity.worktreeRoot ?? null;
  // plan.md "Header layout": status texts and the window title name the repository by its last folder name.
  useEffect(() => {
    document.title = path === null ? "Arbareto" : `${folderName(path)} - Arbareto`;
  }, [path]);

  // plan.md "Marker and frame source": one mark in the next frame after each ready state commits.
  const marked = useRef({ history: 0, commit: -1, details: -1, refs: null as object | null });
  const readReady = completeRead(state.workspace) && !state.refreshing;
  // plan.md D7: the History-ready frame shows the visible rows with their text and cells.
  const historyReady = historyView.windowReady() && readReady;
  const detailsShown = panel === "details" && kept !== null && detailsRead === row.epoch;
  const marks: [boolean, () => boolean, () => void, string][] = [
    [historyReady, () => marked.current.history !== state.historyEpoch, () => void (marked.current.history = state.historyEpoch), "arbareto:history-painted"],
    [panel === "commit" && readReady, () => marked.current.commit !== row.epoch, () => void (marked.current.commit = row.epoch), "arbareto:commit-panel-ready"],
    [detailsShown, () => marked.current.details !== row.epoch, () => void (marked.current.details = row.epoch), "arbareto:details-ready"],
    [historyReady && state.refs !== null, () => marked.current.refs !== state.refs, () => void (marked.current.refs = state.refs), "arbareto:refs-ready"],
  ];
  const due = marks.filter(([ready, open]) => ready && open());
  useEffect(() => {
    if (due.length === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const [, open, done, name] of due) {
        if (!open()) continue;
        done();
        performance.mark(name);
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  // plan.md "Overflow": a newly shown band row or stall notice scrolls into view inside its own region. The focused control stays visible, and focus never moves.
  const seen = useRef(new WeakSet<Element>());
  useLayoutEffect(() => {
    const areaContent = sections.current?.querySelector<HTMLElement>('section[data-slot="status-area"] > div[tabindex="0"]') ?? null;
    const regions: [HTMLElement | null, Element[]][] = [
      [bandRef.current, [...(bandRef.current?.querySelectorAll(":scope > section > div > *") ?? [])]],
      [areaContent, [...(areaContent?.querySelectorAll('[data-slot="stall-notice"]') ?? [])]],
    ];
    for (const [region, rows] of regions) {
      const added = rows.filter((row) => !seen.current.has(row));
      for (const row of rows) seen.current.add(row);
      const row = added.at(-1);
      if (!region || !row) continue;
      const top = region.getBoundingClientRect().top - region.scrollTop;
      const box = (e: Element) => ({ top: e.getBoundingClientRect().top - top, height: e.getBoundingClientRect().height });
      const active = document.activeElement;
      region.scrollTop = overflowScroll({ scrollTop: region.scrollTop, viewportHeight: region.clientHeight, target: box(row), focused: active !== null && region.contains(active) ? box(active) : null });
    }
  });

  // plan.md "Keyboard and focus", Pane navigation: F6 moves through the visible sections in the T346 order.
  function moveSection(direction: "next" | "previous", from?: Section) {
    const root = sections.current;
    if (!root) return;
    const present = new Map<Section, HTMLElement>();
    for (const element of root.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) if (!element.closest("[hidden]")) present.set(element.dataset.section as Section, element);
    // plan.md "Notice band": a band without rows renders no heading and is no F6 stop. The recovery row counts too.
    if (!bandRef.current?.querySelector("h2")) present.delete("noticeHeading");
    // plan.md "Status area": an empty status region is no F6 stop.
    if (!live.current.statusStop) present.delete("statusRegion");
    const sectionOf = (node: Element | null) => node?.closest<HTMLElement>(SECTION_SELECTOR)?.dataset.section as Section | undefined;
    let current = from ?? sectionOf(document.activeElement) ?? "header";
    const order: Section[] = ["header", "noticeHeading", "references", "historyList", "conflicted", "workingChanges", "staged", "comparison", "ignorePreview", "composer", "commitDetails", "changedFiles", "historyDiff", "scopeBar", "pageList", "pageContent", "statusRegion"];
    const hidden = order.filter((s) => !present.has(s));
    // Plan D15 "F6 order per view": a section that takes no focus is skipped. One pass over the order bounds the loop.
    for (let step = 0; step < order.length; step++) {
      const target = nextSection({ panel: live.current.panel ?? "details", hidden, bandRows: present.has("noticeHeading") ? 1 : 0, status: { text: present.has("statusRegion"), toggle: false, cancel: false } }, current, direction);
      if (target === null) return;
      const element = present.get(target)!;
      const remembered = lastFocus.current.get(target);
      let focus: HTMLElement | null;
      if (target === "statusRegion") {
        // The WSL start Cancel, else the T138 entry rule: the area heading once after it opens, then the last target.
        focus = (live.current.starting ? root.querySelector<HTMLElement>('[data-slot="status-area"] button') : null) ?? statusRegion.current?.entry() ?? null;
      } else if (remembered?.isConnected && element.contains(remembered) && !remembered.closest("[hidden]")) focus = remembered;
      else if (target === "noticeHeading") focus = element.querySelector<HTMLElement>("h2");
      // A nested section, such as Changed files inside the commit details, is its own stop.
      else {
        const own = (selector: string) => [...element.querySelectorAll<HTMLElement>(selector)].find((e) => sectionOf(e) === target && !e.closest("[hidden]"));
        focus = own(FILE_TAB_STOP) ?? own(TABBABLE) ?? null;
      }
      (focus ?? element).focus();
      if (sectionOf(document.activeElement) === target) return;
      current = target;
    }
  }
  // plan.md "Notice band": when a band row with focus leaves, focus moves to the band heading while the band keeps a row, else to the next F6 stop.
  useLayoutEffect(() => {
    if (!bandFocusLost.current) return;
    bandFocusLost.current = false;
    const heading = bandRef.current?.querySelector<HTMLElement>("h2");
    if (heading) heading.focus();
    else moveSection("next", "noticeHeading");
  });
  const onSectionFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const section = target.closest<HTMLElement>(SECTION_SELECTOR)?.dataset.section as Section | undefined;
    // Plan D15 "F6 order per view": a click on empty space focuses the section box. The box never counts as the last focus.
    if (section && target.dataset.section === undefined) lastFocus.current.set(section, target);
    if (!menubar.current?.contains(target) && !target.closest('[role="menu"]')) lastOutside.current = target;
  };

  // Contract `openWorktree`: UNKNOWN_TARGET comes before the 001 registration flow, so it takes the plan D15 worktree text.
  const openedWorktree = (response: BridgeResponse) => (responseCode(response) === "UNKNOWN_TARGET" ? setNotice(W.unknownTarget) : registered(response));

  // Feature 005 spec FR-044: unsaved ignore editor text asks first.
  function openRepository() {
    ignore.guard(() => void bridge.chooseRepository(onStart).then((response) => registered(endStart(response))));
  }

  // Feature 005 plan.md D11: the parent is the recent entry that is current before the open, else `entryId: null`.
  function openSubmodule(path: string) {
    ignore.guard(async () => {
      const { repository, workspace: w } = requests.state();
      if (repository === null || w === null) return;
      const recent = await bridge.listRecentRepositories();
      const list = (recent.result as { entries?: { entryId: string; path: string; current: boolean }[] } | undefined)?.entries;
      const current = recent.state === "succeeded" && Array.isArray(list) ? list.find((e) => e.current === true) : undefined;
      const parentPath = current?.path ?? w.identity.worktreeRoot;
      const parent: Parent = { entryId: current?.entryId ?? null, name: folderName(parentPath), path: parentPath };
      const chain = store.getState().parents;
      const response = await bridge.openSubmodule({ repositoryId: repository.repositoryId, path });
      if (response.state === "succeeded" && isRegistration(response.result)) return registered(response, [...chain, parent]);
      setNotice(submoduleRefusal(response, path));
    });
  }
  // Feature 005 spec FR-051: one click opens the parent entry. A missing entry clears the chain.
  function openParent() {
    ignore.guard(async () => {
      const chain = store.getState().parents;
      const top = chain.at(-1);
      if (top === undefined) return;
      const lost = () => {
        setNotice(PARENT_LOST);
        store.setParents([]);
      };
      if (top.entryId === null) return lost();
      const response = await bridge.openRecentRepository({ entryId: top.entryId });
      if (response.state === "succeeded" && isRegistration(response.result)) return registered(response, chain.slice(0, -1));
      if (response.code === "UNKNOWN_TARGET" || response.code === "REPOSITORY_UNAVAILABLE") return lost();
      registered(response);
    });
  }
  // Feature 005 spec FR-054: Blame of a Commit view row opens in History. Escape and Back return to that row.
  const blameReturn = useRef<{ pathBytes: string; category: ChangeEntry["category"] } | null>(null);
  const focusReturn = useRef<{ pathBytes: string; category: ChangeEntry["category"] } | null>(null);
  function blameEntry(entry: ChangeEntry) {
    const w = requests.state().workspace;
    if (w === null || w.head.state === "unborn") return;
    inspection.openBlame({ source: { snapshotId: w.snapshotId, entryId: entry.entryId }, path: entry.path, oid: w.head.oid });
    blameReturn.current = { pathBytes: entry.pathBytes, category: entry.category };
    store.setView(viewKey, "history");
  }
  function blameBack() {
    const back = blameReturn.current;
    blameReturn.current = null;
    if (back === null) {
      // Plan.md D15 "Blame keys": Back returns to the selected History row, so the list shows it again.
      const selected = historyView.getState().selection;
      if (selected !== null) historyView.select(selected.id, selected.index, selected.mode);
      return;
    }
    const entry = requests.state().entries.find((e) => e.pathBytes === back.pathBytes && e.category === back.category);
    if (entry !== undefined) requests.selectEntry(entry.entryId);
    focusReturn.current = back;
    store.setView(viewKey, "commit");
  }
  // The History list slot moves focus in its own effect, so this parent effect runs after it.
  useEffect(() => {
    const back = focusReturn.current;
    if (back === null || view !== "commit") return;
    focusReturn.current = null;
    const entry = state.entries.find((e) => e.pathBytes === back.pathBytes && e.category === back.category);
    if (entry !== undefined) sections.current?.querySelector<HTMLElement>(`[data-file-tree] [role="treeitem"][data-entry-id="${entry.entryId}"]`)?.focus();
  });

  // One page-level shortcut handler (plan.md "Keyboard and focus"). The switcher popup counts as a menu.
  useEffect(() => {
    const handle = createShortcutHandler();
    const onKey = (event: KeyboardEvent) => {
      const { requests, menuOpen, modalOpen, switcherOpen } = live.current;
      // The commit tray handles Ctrl+Enter.
      const action = handle(event, { messageField: null, comparisonPane: comparisonPane.current, modalOpen, menuOpen: menuOpen !== null || switcherOpen, commitEnabled: false });
      if (!action) return;
      if (action.type === "selectHunk") return void stepRef.current?.(action.direction);
      if (action.type === "focusMenuBar") menubar.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      else if (action.type === "refresh") refresh();
      else if (action.type === "openFolder") void openRepository();
      else if (action.type === "openSwitcher") {
        setSwitcherInstant(true);
        setSwitcherOpen(true);
      }
      else if (action.type === "focusSection") moveSection(action.direction);
      else if (action.type === "focusFilter") {
        const target = filterTarget(live.current.view, document.activeElement);
        // Feature 005 plan.md D15: the blame view hides the History list, so its filter takes no focus then.
        if (target === "history" || target === "historyFiles") {
          if (!inspection.getState().blame) (target === "historyFiles" ? historyFilesRef : filterRef).current?.focus();
        }
        else if (target === "files") filesFilterRef.current?.focus();
        else sections.current?.querySelector<HTMLElement>('[data-view="settings"] input[aria-label="Find a setting"]')?.focus();
      }
      else if (action.type === "match") {
        if (!inspection.getState().blame) void historyView.match(action.direction);
      }
      else if (action.type === "sync") runSync.current(action.control);
      else if (action.type === "toggleScope" && live.current.repository !== null) void historyView.setScope(historyView.getState().scope === "current" ? "all" : "current");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  const focusSwitcher = () => switcher.current?.querySelector<HTMLElement>("button")?.focus();
  // plan.md "Required visible states", Starting WSL distro: Cancel returns focus to the repository switcher.
  const cancelStart = (payload: { operationId: string }) => {
    canceledStart.current = payload.operationId;
    focusSwitcher();
    return bridge.cancel(payload);
  };

  // Spec FR-069: an action asks at its first use. After Not now, no action asks again. The chip and Trust… still ask.
  function askTrust(action: TrustAction): Promise<boolean> {
    return declinedNow.current !== null ? Promise.resolve(false) : approveTrust(action);
  }
  // Feature 004 plan.md D12 "Ask": the shell shows the native task dialog. Not now ends `canceled` and stores nothing.
  // True after an approval and the full read that follows it.
  async function approveTrust(action: TrustAction): Promise<boolean> {
    if (repositoryId === null || approving.current) return false;
    // One ask at a time, until the full read after the approval ends. A second ask in that time returns false.
    approving.current = true;
    const end = (approved: boolean) => ((approving.current = false), approved);
    const response = await bridge.approveTrust({ repositoryId }, { action });
    if (requests.state().repository?.repositoryId !== repositoryId) return end(false);
    if (response.state === "canceled") {
      setDeclined(action);
      return end(false);
    }
    const result = response.result as { trustId?: unknown; saveFailed?: unknown } | undefined;
    if (response.state !== "succeeded" || typeof result?.trustId !== "string") {
      setNotice(failureText("Trust approval", response, responseCode(response)));
      return end(false);
    }
    setDeclined(null);
    setSaveFailed(result.saveFailed === true);
    setTrustRead((n) => n + 1);
    return new Promise<boolean>((resolve) => {
      // A waiting caller never stays unsettled.
      approvalRead.current?.(false);
      approvalRead.current = (approved) => resolve(end(approved));
      void requests.trustApproved().then(() => setApprovalEnds((n) => n + 1));
    });
  }

  // A canceled selection keeps the current Git and shows nothing (contract §3 `chooseGit`).
  async function selectGit() {
    const response = await onSelectGit?.();
    if (response !== undefined && response.state !== "succeeded" && response.state !== "canceled") setNotice(codeText("Select Git did not complete: ", responseCode(response)));
  }

  // Feature 004 plan D13: one click reviews the shown snapshot and starts the update. The review names the snapshot of the shown read (contract §12).
  const submoduleUpdate = useSubmoduleUpdate({
    bridge,
    repositoryId,
    current: () => {
      const { repository, workspace: w } = requests.state();
      return repository === null || w === null ? null : { target: { repositoryId: repository.repositoryId, repositoryGeneration: w.generation }, snapshotId: w.snapshotId };
    },
    onOperation: (op) => {
      setOperation(op);
      if (op.response !== null) onEnded("updateSubmodules", op.response);
    },
    snapshotId: workspace?.snapshotId ?? null,
    onReviewFailed: (code) => setNotice(codeText("Submodule review did not complete: ", code)),
    // A host line or a refusal never waits unseen. Only the History view shows the sidebar, so the group takes focus there.
    // The constrained profile mounts the group only while the references section is expanded.
    onAttention: () => {
      setReferencesShown(true);
      if (store.view(viewKey) !== "history") store.setView(viewKey, "history");
    },
  });
  const updateSubmodules = (from: "notice" | "menu" | "group") => {
    reviewOpener.current = from;
    submoduleUpdate.update();
  };
  // A declined Run confirmation returns focus to the opener, else to the nearest surviving logical control.
  // A gone notice button gives the band heading while the band keeps a row (plan.md "Notice band"), else the repository menu, which holds the same action.
  const submoduleOpener = () => {
    if (reviewOpener.current === "notice") {
      const target = noticeButton.current?.isConnected ? noticeButton.current : bandRef.current?.querySelector<HTMLElement>("h2");
      if (target) return target;
    }
    if (reviewOpener.current === "group") {
      const target = document.querySelector<HTMLElement>("[data-submodules-update]");
      if (target) return target;
    }
    return repositoryTrigger.current;
  };

  // Spec FR-074: the status bar states the result. A new trust read gives the new trust state and trust ID.
  async function stopTrusting(trustId: string) {
    if (repositoryId === null) return;
    const response = await bridge.revokeTrust({ repositoryId }, { trustId });
    if (requests.state().repository?.repositoryId !== repositoryId) return;
    setNotice(stoppedText(response));
    setTrustRead((n) => n + 1);
  }

  // Focus returns to the control that had it before the menu bar (plan.md "Keyboard and focus", Menu bar row).
  // The last focused control outside the menu bar and its menus. React focus events of the portal menus also reach the workbench handlers.
  const lastOutside = useRef<HTMLElement | null>(null);
  const onMenubarFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!menubar.current?.contains(event.target as Node)) return;
    if (escapeClose.current) {
      escapeClose.current = false;
      if (beforeMenu.current?.isConnected) return beforeMenu.current.focus();
    }
    const from = event.relatedTarget as HTMLElement | null;
    if (from === null || (!menubar.current?.contains(from) && !from.closest('[data-slot="menubar-content"]'))) beforeMenu.current = from ?? lastOutside.current;
  };
  const finalFocus = () => (beforeMenu.current?.isConnected ? beforeMenu.current : true);
  // An Escape that closes a menu marks the focus return. Base UI then focuses the menu trigger, and `onMenubarFocus` moves focus back.
  const escapeClose = useRef(false);
  const onMenuOpen = (name: string) => (open: boolean, details?: { reason?: string }) => {
    escapeClose.current = !open && details?.reason === "escape-key";
    setMenuOpen((current) => (open ? name : current === name ? null : current));
  };

  const distro = wslDistro(workspace);
  const wslGit = workspace?.location.kind === "wsl" ? workspace.location.git : null;
  // plan.md "Notice band": the blocking row, then the submodule row.
  let conflicted = 0;
  let working = 0;
  let staged = 0;
  for (const e of state.entries) {
    if (e.category === "conflicted") conflicted++;
    else if (e.category === "staged") staged++;
    else working++;
  }
  const blockingRow = workspace !== null && blockingText(workspace.operationState, conflicted) !== null;
  const submodules = workspace?.submoduleNotice.count ?? 0;
  // Feature 002 contract Δ8: a newer `readRefs.refsDigest` or `readWorkspace.head` than the view.
  // A read sent before the view opened can be older than the view, so it never shows the notice.
  const openedSeq = historyState.openedSeq;
  const refsNotice = refsChanged(historyState.view, state.refsSeq > openedSeq ? (state.refs?.refsDigest ?? null) : null, state.headRead !== null && state.headRead.seq > openedSeq ? state.headRead.head : null);
  const connectShown = connect !== null && connect.repositoryId === state.repository?.repositoryId;
  const recoveryShown = recovery !== null && recovery.repositoryId === state.repository?.repositoryId && hasRecoveryRow(recovery.statement);
  // plan.md "Overflow": the band reserves at most two rows and scrolls inside them. The conflict row replaces the blocking row.
  const noticeRows = [blockingRow, submodules > 0, refsNotice, pushNoticeShown, sync.modeChoice, connectShown, recoveryShown].filter(Boolean).length;
  const bandRows = workspace === null ? 0 : Math.min(noticeRows, 2);
  // plan.md "Icons": the Commit tooltip holds both counts, and Commit has no key.
  const commitLabel = `Commit: ${plural(working, "working change", "working changes")}, ${staged} staged`;

  // Sizes in DIPs. Each pane scrolls inside its own bounds (plan.md "Section minima" and "Constrained sizes").
  // `workAreaHeight` needs a plan.md header row count, which only the wide and narrow profiles guarantee.
  const workArea = profile === "constrained" ? client.height : workAreaHeight(client, textScale, preferences.density);
  const tray = paneBounds("tray", { width: client.width, available: workArea, density: preferences.density, textScale });
  const band = paneBounds("fileBand", { width: client.width, available: workArea, density: preferences.density, textScale });
  // The status area is an empty slot until T138, so it takes no rows here.
  const fit = { client, textScale, density: preferences.density, bandRows, statusArea: 0 };
  const remembered = { ...fit, fileBand: panes.fileBand ?? band.default, tray: panes.tray ?? tray.default };
  const clamped = clampPanes({ ...remembered, dock: panes.commitDock ?? undefined });
  const history = historyFit(fit);
  const content = workArea - bandRows * m.bandRow;
  const detailsBounds = dockBounds("details", { width: client.width, available: content, density: preferences.density, textScale });
  const resizable = profile !== "constrained";
  // Feature 004 plan.md D15: the commit workspace lives in the Commit view, so every History dock content takes the details height.
  const dockHeight = Math.min(Math.max(panes.detailsDock ?? detailsBounds.default, detailsBounds.min), detailsBounds.max);
  const listHeight = content - m.splitter - dockHeight;
  const sideBounds = profile === "constrained" ? null : sidebarBounds(profile, client.width);
  const sideWidth = sideBounds === null ? 0 : Math.min(Math.max(panes.sidebar, sideBounds.min), sideBounds.max);
  const markers = environment !== null && hasMarkers(environment);
  // The work area scrolls only when the reduced pane minima do not fit, or below the recovery markers, which no floor reserves.
  const scrolls = markers || (view === "commit" ? clamped.scrolls === true : history.scrolls);
  // The flexible row keeps its computed height only while the work area scrolls. Otherwise it absorbs a shortfall, so the fixed panes stay in view.
  const flexible = `minmax(${scrolls ? clamped.comparison : 0}px, 1fr)`;
  const statusAreaMax = statusAreaHeight({ content: Number.POSITIVE_INFINITY, client, textScale, density: preferences.density, bandRows });

  // The states that block mutations (plan.md "Required visible states": Busy, State unknown, Conflicted/unfinished operation, Limited output).
  const running = operation !== null && operation.response === null;
  const loading = workspace === null || state.entries.length < workspace.entryCount;
  // Spec FR-103 and SC-017: the dock names the conflicted count only during a merge or a rebase, and only from a complete read.
  const conflictCount = loading || (workspace.operationState !== "merging" && workspace.operationState !== "rebasing") ? 0 : conflicted;
  const stateBlocked: Blocked = state.blocked ? "unknown" : workspace !== null ? operationBlock(workspace.operationState) : null;
  const blocked: Blocked = running ? (operation.kind === "applyFile" ? "busy" : "running") : stateBlocked;
  const blockedReason = blocked === null ? null : BLOCKED_TEXT[blocked];
  const stagingBlocked: Blocked = blocked ?? (loading ? "loading" : workspace.completeness.state !== "complete" ? "incomplete" : null);
  const onEnded = (kind: "applyHunk" | "applyFile" | "commit" | "updateSubmodules" | "sync", response: BridgeResponse) => requests.mutationEnded(kind, response);
  const shownTracking = tracking !== null && tracking.repositoryId === repositoryId ? tracking : null;
  const entries = shownTracking?.entries ?? null;
  const trackingFailure = shownTracking?.failure ?? null;
  const labels = useMemo(() => trackingLabels(entries, state.refs), [entries, state.refs]);
  // Plan.md D8: the toolbar uses the `*` entry of the checked-out branch.
  const currentHead = workspace?.head ?? null;
  const currentEntry = currentHead !== null && currentHead.state === "branch" ? (entries?.find((e) => e.current && `refs/heads/${e.name}` === currentHead.target && e.objectId === currentHead.oid) ?? null) : null;
  const currentLabel = currentEntry === null ? null : (labels.get(currentEntry.name) ?? null);
  // The reason that blocks every sync action: a running mutation, an unknown state, or the reconcile read after a mutation.
  // The sync controls show the running and the reconcile reason only in the tooltip (plan.md D12).
  const stateSyncBlock = running ? BLOCKED_TEXT.running : state.blocked ? BLOCKED_TEXT.unknown : null;
  const syncBlock = stateSyncBlock ?? (state.reconciling ? RECONCILING_REASON : null);
  // A running mutation or a state-unknown read comes first, so the reconcile reason then is no quiet reason.
  const reconciling = state.reconciling && stateSyncBlock === null;
  const quietSync = quietReason(running, reconciling);
  const upstreamState = currentEntry === null ? null : currentEntry.upstream === null ? "none" : "set";
  const reasons = syncReasons(currentHead, workspace?.operationState ?? null, upstreamState, syncBlock);
  // Commit and push waits for its own reconcile read before the push review, so the read does not block it.
  const commitPushReason = syncReasons(currentHead, workspace?.operationState ?? null, upstreamState, stateSyncBlock).commitPushReason;
  const runSync = useRef<(control: "fetch" | "pull" | "push") => void>(() => {});
  runSync.current = (control) => {
    if (state.repository === null) return;
    if (control === "fetch" && reasons.fetchReason === null) sync.run({ action: "fetch" });
    if (control === "push" && reasons.pushReason === null) sync.run({ action: "push" });
    const main = syncSettings.action;
    if (control === "pull" && main !== null && actionReason(reasons, main) === null) sync.run(pullAction(main).payload);
  };
  // Plan D15 running rule: a running mutation blocks the 004 actions with the 003 running reason.
  const mutationReason = running ? RUNNING_REASON : blockedReason;
  const branches = useBranchActions({
    bridge,
    askTrust,
    target: requests.target,
    repositoryId,
    refsDigest,
    onOperation: setOperation,
    workbench: store,
    head: currentHead,
    blockedReason: mutationReason,
    blockedRunning: running,
    onNotice: setNotice,
    onMerge: (entry, opener) => openIntegrate({ action: "merge", ref: entry.ref, name: entry.name }, opener),
    onRebase: (entry, opener) => openIntegrate({ action: "rebase", ref: entry.ref, name: entry.name }, opener),
    onAddWorktree: (selection, opener) => worktrees.startAdd(opener, selection),
    onOpenWorktree: (path) => void (repositoryId === null ? undefined : ignore.guard(() => void bridge.openWorktree({ repositoryId, path }).then(openedWorktree))),
    push: { reason: quietSync ?? reasons.pushReason, quiet: quietSync !== null, run: () => runSync.current("push") },
    onShowBranchHistory: () => void historyView.setScope("current"),
  });
  // Feature 004 WP21 (spec FR-049 to FR-057): the worktree button, the sidebar Worktrees group, and the Add worktree panel.
  const worktrees = useWorktreeActions({
    bridge,
    askTrust,
    target: requests.target,
    repositoryId,
    refsDigest,
    workbench: store,
    worktreeRoot: path,
    start: panel === "details" && kept !== null ? kept : currentHead === null || currentHead.state === "unborn" ? null : currentHead.oid,
    blockedReason: mutationReason,
    running,
    onOperation: setOperation,
    onNotice: setNotice,
    onOpen: (worktree) => void (repositoryId === null ? undefined : ignore.guard(() => void bridge.openWorktree({ repositoryId, path: worktree }).then(openedWorktree))),
    onDock: () => {
      setIntegrate(null);
      store.setView(viewKey, "history");
    },
  });
  const trackingCount =
    currentHead === null ? null : currentHead.state === "detached" || trackingFailure !== null ? (
      <span data-slot="tracking-count" className="shrink-0 text-muted-text">
        {currentHead.state === "detached" ? NO_BRANCH : trackingFailure}
      </span>
    ) : (
      <TrackingCount label={currentLabel} upstream={currentEntry?.upstream ?? null} />
    );
  const staging: Staging = {
    bridge,
    target: state.repository !== null && state.capability !== null ? { repositoryId: state.repository.repositoryId, repositoryGeneration: state.capability.repositoryGeneration } : null,
    blocked: stagingBlocked,
    trust: trust?.report ?? null,
    eligibility: workspace?.hunkEligibility,
    fileReasonId,
    reasons: [
      { id: fileReasonId, ...fileReason },
      { id: paneReasonId, ...paneReason },
    ],
    onFileReason: (text, quiet = false) => setFileReason({ text, quiet }),
    onPaneReason: (text, quiet = false) => setPaneReason({ text, quiet }),
    onOperation: (op) => {
      // A new file action replaces the output of the last failed one.
      if (op.kind === "applyFile" && op.response === null && op.progress === null) setFileFailure(null);
      setOperation(op);
    },
    onEnded,
    onFileFailed: (file, response) => setFileFailure({ file, response }),
    fileFailure,
    onHunkSucceeded: (file, ordinal, patch) => {
      // plan.md: a successful hunk action clears the hunk selection and selects no other hunk.
      setAnchor({ file, ordinal, patch });
      requests.selectHunk(null);
    },
    anchor,
    stepRef,
    toolbarSuccess,
    onToolbarSuccess: (entryId) => setToolbarSuccess({ entryId }),
  };
  const pane: WorkbenchPaneProps = {
    state,
    requests,
    density: preferences.density,
    profile,
    textScale,
    menuOpen: menuOpen !== null,
    modalOpen,
    onStatus: setPaneStatus,
    historyListMin: history.listMin,
    selected: kept,
    onSelectRow,
    staging,
    history: historyView,
    filterRef,
    filesFilterRef,
    tracking: labels,
    workbench: store,
    branches,
    onTrustReads: () => void approveTrust("read"),
    askTrust,
    commitActions: {
      ignore,
      onBlame: blameEntry,
      onOpenSubmodule: openSubmodule,
      submoduleReason: (pathBytes) => openSubmoduleReason(submoduleUpdate.rows, pathBytes, parents.length),
    },
  };
  // Feature 004 plan.md D16 "Geometry": the Commit view holds the commit workspace without the references sidebar.
  const commitProfile = commitViewProfile(profile, client.width);
  const laneBounds = paneBounds("fileLane", { width: client.width, available: workArea, density: preferences.density, textScale });
  const lane = Math.min(Math.max(panes.fileLane, laneBounds.min), laneBounds.max);
  const trayHeight = clamped.tray;
  const bandHeight = clamped.fileBand ?? band.default;
  const grid: CSSProperties =
    commitProfile === "wide"
      ? {
          gridTemplateColumns: `${lane}px ${m.splitter}px minmax(0, 1fr)`,
          gridTemplateRows: `${flexible} ${m.splitter}px ${trayHeight}px`,
          gridTemplateAreas: '"lane laneSplit comparison" "lane laneSplit traySplit" "lane laneSplit tray"',
        }
      : commitProfile === "narrow"
        ? {
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: `${bandHeight}px ${m.splitter}px ${flexible} ${m.splitter}px ${trayHeight}px`,
            gridTemplateAreas: '"lane" "laneSplit" "comparison" "traySplit" "tray"',
          }
        : {
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: `${bandHeight}px 0 ${flexible} 0 ${trayHeight}px`,
            gridTemplateAreas: '"lane" "laneSplit" "comparison" "traySplit" "tray"',
          };

  // plan.md "Status area": the status bar text is the live region, so a start shows there too.
  // Spec FR-048: the Commit view states the counts of a fully loaded status read.
  const showCounts = view === "commit" && workspace !== null && !loading;
  const cut = workspace?.cut === "untracked";
  // One pass over the entries per snapshot. A progress event re-renders the workbench with the same entries.
  const counts = useMemo(() => (showCounts ? countsText(state.entries, cut) : null), [showCounts, state.entries, cut]);
  const statusText = starting !== null ? wslStartingText(starting.distro) : state.refreshing ? "Refreshing…" : state.blocked ? "State unknown" : (notice ?? (state.repository === null && !restoring ? NO_REPOSITORY : counts));
  const gitVersion = wslGit?.version ?? environment?.detectedVersion ?? null;

  const pushBranch = currentHead !== null && currentHead.state !== "detached" ? branchName(currentHead.target) : null;
  const pushPanel = sync.panel !== null && pushBranch !== null ? <PushPanel branch={pushBranch} plan={sync.panel} onPush={sync.push} onCancel={sync.closePanel} /> : null;
  // Feature 004 spec FR-029 and plan.md D15 "Commit view layout": the lists on the left, the diff on the right, and the message editor below the diff.
  const commitPanel = (
    <div ref={commitPanelRef} hidden={pushPanel !== null} className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1" style={grid}>
        <div data-section="workingChanges" tabIndex={-1} className="min-h-0 overflow-auto" style={{ gridArea: "lane" }}>
          <ChangesPane {...pane} profile={commitProfile} />
        </div>
        <Splitter
          label={commitProfile === "wide" ? "Resize file lane" : "Resize file band"}
          orientation={commitProfile === "wide" ? "vertical" : "horizontal"}
          value={commitProfile === "wide" ? lane : bandHeight}
          min={commitProfile === "wide" ? laneBounds.min : band.min}
          max={commitProfile === "wide" ? laneBounds.max : band.max}
          onChange={resize(commitProfile === "wide" ? "fileLane" : "fileBand")}
          onCommit={keepPane(commitProfile === "wide" ? "fileLane" : "fileBand")}
          className={resizable ? "[grid-area:laneSplit]" : "hidden"}
        />
        <div ref={comparisonPane} data-section="comparison" tabIndex={-1} className="min-h-0 overflow-auto" style={{ gridArea: "comparison" }}>
          {/* Feature 005 plan.md D15 "Ignore editor": the editor takes the diff region. */}
          <div hidden={ignoreState.editor !== null} className="h-full min-h-0">
            <ComparisonView {...pane} />
          </div>
          {ignoreState.editor === null ? null : <IgnoreEditorMemo store={ignore} onTrust={trustReads} />}
        </div>
        <div className="[grid-area:traySplit]">
          <Splitter label="Resize commit tray" orientation="horizontal" value={trayHeight} min={tray.min} max={tray.max} reverse onChange={resize("tray")} onCommit={keepPane("tray")} className={resizable ? undefined : "hidden"} />
        </div>
        <div data-section="composer" tabIndex={-1} className="min-h-0 overflow-auto border-t border-divider p-2" style={{ gridArea: "tray" }}>
          <CommitTray
            bridge={bridge}
            target={state.repository !== null && workspace !== null ? { repositoryId: state.repository.repositoryId, repositoryGeneration: workspace.generation } : null}
            snapshotId={workspace?.snapshotId ?? null}
            worktreeKey={worktreeKey}
            drafts={drafts}
            head={workspace?.head ?? null}
            staged={staged}
            // Plan.md D15 "Limited status": a cut inside the untracked records keeps Commit available, because its review reads the staged scope.
            status={loading ? "loading" : workspace.completeness.state !== "complete" && workspace.cut !== "untracked" ? "incomplete" : null}
            blocked={blocked}
            requestTrust={(report) => {
              setTrust({ report });
              return askTrust("commit");
            }}
            trustReason={declined !== null && trust !== null && trustBeforeReview(trust.report) ? COMMIT_TRUST_TEXT : null}
            onOperation={setOperation}
            onEnded={(response) => onEnded("commit", response)}
            fieldRef={messageField}
            onPush={() => sync.run({ action: "push" })}
            pushReason={commitPushReason}
            operationState={workspace?.operationState}
            amend={{ value: commitState.amend, onChange: (amend) => store.setCommitView(viewKey, { amend }) }}
            spelling={spelling}
          />
        </div>
      </div>
    </div>
  );

  // The Commit view shows the push panel and the commit workspace. The dock of the hidden History view then holds neither.
  const inCommitView = view === "commit";
  // Plan.md D15 and O-11: the Working directory and Index rows dock a summary. Enter or a double-click on the row opens the Commit view.
  // 001 FR-005: the switch hides the focused History view, so focus moves to the Changes Tab-stop row, else to Filter files.
  // Focus that is already in the shown Commit view stays, such as the push panel focus.
  const focusCommitEntry = () => {
    const active = document.activeElement;
    if (active?.closest('[data-view="commit"]') && !active.closest("[hidden]")) return;
    (sections.current?.querySelector<HTMLElement>('[data-file-tree="changes"] [role="treeitem"][tabindex="0"]') ?? filesFilterRef.current)?.focus();
  };
  const commitEntryPending = useRef(false);
  const openCommitView = () => {
    if (inCommitView) return focusCommitEntry();
    commitEntryPending.current = true;
    store.setView(viewKey, "commit");
  };
  useLayoutEffect(() => {
    if (!commitEntryPending.current || !inCommitView) return;
    commitEntryPending.current = false;
    focusCommitEntry();
  });
  // Feature 004 spec FR-106: the first Conflicted row in tree order gets the selection, its resolve view, and the focus.
  // From History, the focus effect above moves the focus after the view switch.
  const resolveConflicts = () => {
    const first = conflictedRows(requests.state().entries)[0];
    if (first?.kind !== "file") return;
    if (requests.state().selection?.entryId !== first.entry.entryId) requests.selectEntry(first.entry.entryId);
    if (inCommitView) return sections.current?.querySelector<HTMLElement>(`[data-file-tree="conflicted"] [role="treeitem"][data-entry-id="${first.entry.entryId}"]`)?.focus();
    focusReturn.current = { pathBytes: first.entry.pathBytes, category: first.entry.category };
    store.setView(viewKey, "commit");
  };
  const onHistoryKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || isEditable(event.target as HTMLElement)) return;
    const list = (event.target as HTMLElement).closest<HTMLElement>("[data-history-list]");
    const active = list === null ? null : document.getElementById(list.getAttribute("aria-activedescendant") ?? "");
    const id = active?.dataset.rowId;
    if (id === WORKING_ROW || id === INDEX_ROW) openCommitView();
  };
  const onHistoryDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    if (id === WORKING_ROW || id === INDEX_ROW) openCommitView();
  };
  // Plan D15 "Docked panel": a docked panel takes its content height, at most 60% of the work area.
  const integrateDocked = integrate !== null && integrate.key === viewKey && pushBranch !== null;
  const docked = integrateDocked || worktrees.addPanel !== null;
  const dockedMax = 0.6 * workArea;
  const dock = (
    <DockRegion
      panel={
        !integrateDocked ? worktrees.addPanel : (
          <IntegratePanel
            askTrust={askTrust}
            request={integrate.request}
            current={pushBranch}
            bridge={bridge}
            target={state.repository !== null && workspace !== null ? { repositoryId: state.repository.repositoryId, repositoryGeneration: workspace.generation } : null}
            blockedReason={mutationReason}
            operationRunning={running}
            onOperation={setOperation}
            onEnded={(response) => store.ended("runWorkbench", response)}
            opener={integrate.opener}
            onClose={() => setIntegrate(null)}
          />
        )
      }
    >
      {inCommitView ? null : pushPanel}
      {inCommitView || panel !== "commit" || pushPanel !== null || blameOpen ? null : <WorkingSummary working={working} staged={staged} conflicted={conflictCount} onOpen={openCommitView} onResolve={resolveConflicts} />}
      {/* Feature 005 plan.md D15 "Blame view": the dock shows the commit details of the selected blame line. */}
      {blameOpen ? (
        lineOid === null || pushPanel !== null ? null : (
          <div data-section="commitDetails" tabIndex={-1} className="h-full min-h-0">
            <ViewCommitDetails view={historyView} oid={lineOid} />
          </div>
        )
      ) : panel === "details" && kept !== null && pushPanel === null ? (
        <div data-section="commitDetails" tabIndex={-1} className="h-full min-h-0">
          <ViewCommitDetails
            view={historyView}
            oid={kept}
            onRead={() => setDetailsRead(row.epoch)}
            profile={profile}
            width={historyPanes.details}
            onWidth={(details) => setHistoryPanes((p) => ({ ...p, details }))}
            changes={
              <CommitChanges
                inspection={inspection}
                view={historyView}
                oid={kept}
                profile={profile}
                filterRef={historyFilesRef}
                panes={historyPanes}
                onPanes={(next) => setHistoryPanes((p) => ({ ...p, ...next }))}
                onTrust={() => approveTrust("read")}
                onBlame={(request) => {
                  blameReturn.current = null;
                  inspection.openBlame(request);
                }}
              />
            }
          />
        </div>
      ) : null}
      {panel === null && pushPanel === null && !blameOpen ? <p className="p-2 text-muted-text">{DOCK_HINT}</p> : null}
    </DockRegion>
  );

  // Feature 004 plan D15 "P2 regions": the Submodules group sits in the sidebar below the references.
  const submodulesGroup =
    workspace === null ? null : (
      <div className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-divider" onFocusCapture={() => void (reviewOpener.current = "group")}>
        <SubmodulesGroup
          update={submoduleUpdate}
          runningReason={running ? RUNNING_REASON : null}
          blockedReason={stateBlocked === null ? null : BLOCKED_TEXT[stateBlocked]}
          onCancel={() => statusRegion.current?.requestCancel()}
          onTrustReads={() => void approveTrust("read")}
          onOpen={openSubmodule}
          onRefused={setNotice}
          chain={parents.length}
        />
      </div>
    );
  // 001 plan.md "References sidebar": the constrained section collapses to its heading row, so the group scrolls with the references there.
  const constrained = profile === "constrained";
  const refsSidebar = (
    <SidebarAfter
      value={
        state.repository === null ? null : (
          <>
            <WorktreesGroup actions={worktrees} rowHeight={m.row} />
            {constrained ? submodulesGroup : null}
          </>
        )
      }
    >
      <ReferencesSidebarMemo
        refs={state.refs}
        failure={state.refsFailure}
        rowHeight={m.row}
        onSelectCommit={selectCommit}
        onRefresh={refresh}
        collapsible={profile === "constrained"}
        scrollElement={constrained ? referencesElement : undefined}
        expanded={constrained ? referencesShown : undefined}
        onExpandedChange={constrained ? setReferencesShown : undefined}
        repository={state.repository?.worktreeKey ?? ""}
        onShowBranchHistory={showBranchHistory}
        tracking={labels}
        onBranchAction={branches.entries === null ? undefined : onBranchAction}
        branches={branches.entries}
        after={SIDEBAR_AFTER}
      />
    </SidebarAfter>
  );
  // Outside the constrained profile, the Submodules group scrolls inside its own region.
  const sidebar =
    submodulesGroup === null || constrained ? (
      refsSidebar
    ) : (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">{refsSidebar}</div>
        {submodulesGroup}
      </div>
    );

  const workbench =
    profile === "constrained" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* plan.md "References sidebar": expanded, the section takes the reduced pane minimum and no more height. */}
        {/* plan.md "Section minima": its content keeps its own height and scrolls inside the section, so every group stays reachable. */}
        <div ref={referencesSection} data-section="references" tabIndex={-1} data-references-scroll="" className="shrink-0 overflow-y-auto border-b border-divider" style={{ height: "auto", maxHeight: m.reducedPaneMin }}>
          {/* A block wrapper of content height. The sidebar height then resolves to its content, not to the section height. */}
          <div>{sidebar}</div>
        </div>
        <section aria-label="History" data-section="historyList" tabIndex={-1} className="flex min-h-0 flex-col" style={{ flex: "1 1 0" }} onKeyDown={onHistoryKey} onDoubleClick={onHistoryDoubleClick}>
          <HistoryListSlot inspection={inspection} onSelectCommit={(oid) => historyView.revealOid(oid)} onBack={blameBack}>
            <HistoryView {...pane} />
          </HistoryListSlot>
        </section>
        <section aria-label="Dock" className="flex min-h-0 flex-col border-t border-divider" style={{ flex: "0 0 auto", minHeight: m.reducedPaneMin, maxHeight: docked ? dockedMax : undefined }}>
          {dock}
        </section>
      </div>
    ) : (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `${sideWidth}px ${m.splitter}px minmax(0, 1fr)` }}>
        <div data-section="references" tabIndex={-1} className="min-h-0 border-r border-divider">
          {sidebar}
        </div>
        <Splitter label="Resize references sidebar" orientation="vertical" value={sideWidth} min={sideBounds!.min} max={sideBounds!.max} onChange={resize("sidebar")} onCommit={keepPane("sidebar")} />
        <div className="flex min-h-0 flex-col">
          <section
            aria-label="History"
            data-section="historyList"
            tabIndex={-1}
            className="flex min-h-0 flex-col"
            style={docked ? { flex: "1 1 0", minHeight: m.historyListMin } : { flex: "0 0 auto", height: Math.max(listHeight, m.historyListMin) }}
            onKeyDown={onHistoryKey}
            onDoubleClick={onHistoryDoubleClick}
          >
            <HistoryListSlot inspection={inspection} onSelectCommit={(oid) => historyView.revealOid(oid)} onBack={blameBack}>
              <HistoryView {...pane} />
            </HistoryListSlot>
          </section>
          {/* The dock splitter sets the height of the dock content. A docked panel takes its own height, so the splitter hides. */}
          <Splitter
            label="Resize dock"
            orientation="horizontal"
            value={dockHeight}
            min={detailsBounds.min}
            max={detailsBounds.max}
            reverse
            onChange={resize("detailsDock")}
            onCommit={keepPane("detailsDock")}
            className={docked ? "hidden" : undefined}
          />
          <section aria-label="Dock" className={`flex min-h-0 flex-col ${docked ? "border-t border-divider" : "flex-1"}`} style={docked ? { flex: "0 0 auto", maxHeight: dockedMax } : undefined}>
            {dock}
          </section>
        </div>
      </div>
    );

  return (
    <CopyFailed value={() => setNotice(COPY_FAILED_TEXT)}>
      <div ref={sections} data-profile={profile} className="flex h-dvh flex-col overflow-clip bg-canvas text-text" onFocus={onSectionFocus}>
        {markers ? (
          <div data-slot="recovery-markers" className="max-h-[40dvh] shrink-0 overflow-y-auto border-b border-divider p-2">
            <RecoveryMarkers environment={environment} onDismissMarker={(markerId) => void dismissMarker(markerId)} />
          </div>
        ) : null}
        {/* Feature 004 plan.md D15 "Top bar row": one row while the controls fit at their text widths. Otherwise the last controls wrap. */}
        <header data-section="header" tabIndex={-1} className="flex flex-wrap items-center gap-x-2 border-b border-divider px-2" style={{ minHeight: "var(--h-header)" }}>
          <div ref={switcher} className="flex min-w-[160px] shrink items-center gap-2" style={{ order: 1, minHeight: "var(--h-header)" }}>
            {parents.length === 0 ? null : <ParentButton parent={parents.at(-1)!} onOpen={openParent} />}
            <RepositorySwitcher
              bridge={bridge}
              worktreeRoot={path}
              busy={running}
              open={switcherOpen}
              instant={switcherInstant}
              onOpenChange={(open, instant = false) => {
                setSwitcherInstant(instant);
                setSwitcherOpen(open);
              }}
              onOpenFolder={() => void openRepository()}
              onOpened={registered}
              guard={ignore.guard}
            />
          </div>
          {distro === null ? null : (
            <span className="flex shrink-0 items-center" style={{ order: 2 }}>
              <WslBadge distro={distro} textScale={textScale} />
            </span>
          )}
          {workspace === null ? null : (
            <BranchButton head={workspace.head} operationState={workspace.operationState} counts={currentLabel} tracking={labels} actions={branches} blockedReason={mutationReason} rowHeight={m.row} headingHeight={m.subgroupHeading} />
          )}
          {workspace === null ? null : <WorktreeButton actions={worktrees} worktreeRoot={path} rowHeight={m.row} itemHeight={m.row + m.helpLine} headingHeight={m.subgroupHeading} />}
          {state.repository === null ? null : (
            // The 004 design standard: the Fetch, Pull, and Push group follows the branch. Feature 004 adds its branch and worktree buttons before it.
            // Plan.md D15 "Top bar row": the group grows only after the branch button reaches its text width, so its reason line takes the rest.
            <span className="flex items-center" style={{ order: 4, flexGrow: 1 }}>
              <SyncToolbar
                reasons={reasons}
                defaultAction={syncSettings.action}
                settingsReason={syncSettings.reason}
                count={trackingCount}
                running={running ? { action: operation.kind === "sync" ? (operation.sync?.action ?? null) : null, cancelRequested: operation.progress?.state === "cancel-requested" } : null}
                reconciling={reconciling}
                onRun={sync.run}
                onCancel={() => statusRegion.current?.requestCancel()}
                onSetDefault={(action) => void setDefaultPullAction(action)}
              />
            </span>
          )}
          {state.repository === null ? null : (
            // Spec FR-033: the view switch has no key.
            <span className="flex shrink-0 items-center" style={{ order: 5 }}>
              <Segmented label="Views" options={VIEW_OPTIONS} value={view === "settings" ? null : view} onChange={(next) => store.setView(viewKey, next)} />
            </span>
          )}
          <div ref={menubar} className="flex items-center" style={{ order: 6, minHeight: "var(--h-header)" }} onFocus={onMenubarFocus}>
            <Menubar className="h-auto border-0 p-0">
              <RepositoryMenu
                key={repositoryId}
                triggerRef={repositoryTrigger}
                onOpenRepository={() => void openRepository()}
                onOpenRecent={() => {
                  setSwitcherInstant(false);
                  setSwitcherOpen(true);
                }}
                onSelectGit={() => void selectGit()}
                onClone={() => setMainPanel("clone")}
                onOpenSettings={openSettings}
                onUpdateSubmodules={workspace === null ? undefined : () => updateSubmodules("menu")}
                updateSubmodulesReason={blockedReason}
                onEditIgnore={
                  workspace === null
                    ? undefined
                    : (target) => {
                        store.setView(viewKey, "commit");
                        ignore.open(target);
                      }
                }
                onOpenChange={onMenuOpen("repository")}
                finalFocus={finalFocus}
              />
              <MenubarMenu onOpenChange={onMenuOpen("view")}>
                <MenubarTrigger>View</MenubarTrigger>
                <MenubarContent finalFocus={finalFocus} className={MENU_CONTENT}>
                  {/* plan.md "Dark palettes": Theme ▸ System, Light, and Dark ▸ palettes. Exactly one of the three theme entries shows as checked. */}
                  <MenubarSub>
                    <MenubarSubTrigger>Theme</MenubarSubTrigger>
                    <MenubarSubContent className={MENU_CONTENT}>
                      <MenubarRadioGroup value={preferences.theme === "dark" ? "" : preferences.theme} onValueChange={(theme) => savePreferences({ ...preferences, theme: theme as Theme })}>
                        <MenubarRadioItem value="system">System (dark: {paletteLabel(preferences.darkPalette)})</MenubarRadioItem>
                        <MenubarRadioItem value="light">Light</MenubarRadioItem>
                      </MenubarRadioGroup>
                      <MenubarSub>
                        <MenubarSubTrigger data-checked={preferences.theme === "dark" ? "true" : undefined} className="relative pl-7.5">
                          {preferences.theme === "dark" ? (
                            <span aria-hidden="true" className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
                              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
                            </span>
                          ) : null}
                          Dark
                          {preferences.theme === "dark" ? <span className="sr-only">, {paletteLabel(preferences.darkPalette)}</span> : null}
                        </MenubarSubTrigger>
                        <MenubarSubContent className={MENU_CONTENT}>
                          {/* A palette choice selects the Dark theme and that palette in one step. */}
                          <MenubarRadioGroup value={preferences.darkPalette}>
                            {DARK_PALETTES.map((p) => (
                              <MenubarRadioItem key={p.value} value={p.value} onClick={() => savePreferences({ ...preferences, theme: "dark", darkPalette: p.value })}>
                                {p.label}
                              </MenubarRadioItem>
                            ))}
                          </MenubarRadioGroup>
                        </MenubarSubContent>
                      </MenubarSub>
                    </MenubarSubContent>
                  </MenubarSub>
                  <MenubarSeparator />
                  <MenubarRadioGroup value={preferences.density} onValueChange={(density) => savePreferences({ ...preferences, density: density as Density })}>
                    <MenubarLabel>Density</MenubarLabel>
                    {DENSITIES.map((d) => (
                      <MenubarRadioItem key={d.value} value={d.value}>
                        {d.label}
                      </MenubarRadioItem>
                    ))}
                  </MenubarRadioGroup>
                  <MenubarSeparator />
                  {/* Feature 002 plan.md D6 "Branch scope": the approved mockup canvas puts it after Density. */}
                  <MenubarCheckboxItem
                    aria-keyshortcuts="Control+Shift+B"
                    checked={historyState.scope === "current"}
                    disabled={state.repository === null}
                    onCheckedChange={(checked) => void historyView.setScope(checked ? "current" : "all")}
                  >
                    Current branch only<MenuKey>Ctrl+Shift+B</MenuKey>
                  </MenubarCheckboxItem>
                  <MenubarSeparator />
                  <MenubarItem
                    onClick={() => {
                      setDragPanes({});
                      savePreferences({ ...preferences, panes: DEFAULT_PREFERENCES.panes });
                    }}
                  >
                    Reset pane sizes
                  </MenubarItem>
                  <MenubarSeparator />
                  {/* Feature 004 plan.md D15: View ▸ Settings… opens the Settings view. */}
                  <MenubarItem onClick={openSettings}>Settings…</MenubarItem>
                </MenubarContent>
              </MenubarMenu>
              <MenubarMenu onOpenChange={onMenuOpen("help")}>
                <MenubarTrigger ref={helpTrigger}>Help</MenubarTrigger>
                <MenubarContent finalFocus={finalFocus} className={MENU_CONTENT}>
                  <MenubarGroup>
                    <MenubarLabel className="whitespace-normal">{SCOPE_LINE}</MenubarLabel>
                  </MenubarGroup>
                  <MenubarSeparator />
                  <MenubarItem disabled={environment === null} onClick={() => setAboutOpen(true)}>
                    About Arbareto
                  </MenubarItem>
                </MenubarContent>
              </MenubarMenu>
            </Menubar>
          </div>
          <span className="flex items-center gap-1" style={{ order: 7, minHeight: "var(--h-header)" }}>
            <IconButton icon={RefreshIcon} label="Refresh" keys={{ aria: "F5", text: "F5" }} disabled={!state.repository} onClick={refresh} />
            {/* Feature 004 plan.md D15 top bar: the Commit icon opens the Commit view and focuses Working changes. */}
            <IconButton
              icon={GitCommitIcon}
              label={commitLabel}
              disabled={!state.repository}
              onClick={openCommitView}
            />
            {state.repository === null ? null : (
              <span aria-hidden="true" className="num text-muted-text">
                {working + staged}
              </span>
            )}
          </span>
        </header>

        <main className={`flex min-h-0 flex-1 flex-col ${scrolls ? "overflow-y-auto" : "overflow-clip"}`}>
          {/* plan.md "Overflow": the band shows at most its two reserved rows and scrolls inside them. */}
          <div ref={bandRef} data-slot="notice-band" data-section="noticeHeading" tabIndex={-1} className="shrink-0 overflow-y-auto" style={{ maxHeight: 2 * m.bandRow }}>
            {workspace === null ? null : (
              <NoticeBand
                operationState={workspace.operationState}
                conflicted={conflicted}
                recovery={recovery !== null && recovery.repositoryId === state.repository?.repositoryId ? recovery.statement : undefined}
                pushRow={
                  sync.notice !== null ? (
                    <PushNoticeRow notice={sync.notice} {...sync.noticeActions} reason={reasons.pullReason} fetchReason={reasons.fetchReason} running={running} reconciling={reconciling} bindControl={bindBandControl} />
                  ) : undefined
                }
                pullModeRow={sync.modeChoice ? <PullModeChoice onChoose={sync.chooseMode} onCancel={sync.cancelMode} reason={syncBlock} running={running} reconciling={reconciling} bindControl={bindBandControl} /> : undefined}
                conflictRow={
                  workspace.operationState === "merging" || workspace.operationState === "rebasing" ? (
                    // A new operation state or HEAD is a new stop, so the row forgets the refusals of the last stop.
                    <ConflictRow
                      key={`${workspace.operationState}:${workspace.head.state === "unborn" ? "" : workspace.head.oid}`}
                      operationState={workspace.operationState}
                      conflicted={conflicted}
                      reason={syncBlock}
                      running={running}
                      reconciling={reconciling}
                      loading={loading}
                      onAction={sync.conflictAction}
                      onResolve={resolveConflicts}
                      bindControl={bindBandControl}
                    />
                  ) : undefined
                }
                connectRow={
                  connectShown ? (
                    <ConnectNoticeRow
                      name={connect.name}
                      connect={() => bridge.connectInTerminal({ repositoryId: connect.repositoryId }, { operationId: connect.operationId })}
                      onDismiss={() => setConnect(null)}
                      bindControl={bindBandControl}
                    />
                  ) : undefined
                }
                submoduleRow={submodules > 0 ? <SubmoduleNotice count={submodules} onUpdate={() => updateSubmodules("notice")} buttonRef={bindNoticeButton} blockedReason={blockedReason} /> : undefined}
                refsChanged={
                  refsNotice ? (
                    <Button ref={bindBandControl} variant="outline" size="sm" onClick={refresh}>
                      Refresh
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
          {/* The Windows shell checks a destination by the 001 Windows rules or the §11 WSL route, and both use the backslash separator (contract Δ3 `clone`). */}
          {mainPanel === "clone" ? (
            <CloneDialog
              bridge={bridge}
              separator={"\\"}
              guard={ignore.guard}
              onOpened={(response) => {
                setMainPanel(null);
                registered(response);
              }}
              onClose={() => setMainPanel(null)}
            />
          ) : null}
          {mainPanel === null && view === "settings" ? (
            <Suspense fallback={null}>
              <SettingsView
                bridge={bridge}
                target={state.repository !== null && workspace !== null ? { repositoryId: state.repository.repositoryId, repositoryGeneration: workspace.generation } : null}
                wslDistro={workspace?.location.kind === "wsl" ? workspace.location.distro : null}
                spelling={spelling.store}
                repository={worktreeKey === null ? null : { worktreeKey, proposals: keyProposals(trust?.report) }}
                operationRunning={running}
                onOperation={setOperation}
                onEnded={(response) => store.ended("runWorkbench", response)}
                onSettings={(response) => setSyncSettings(settingsOf(response))}
                page={store.settingsPage(viewKey)}
                onClose={() => store.closeSettings(viewKey)}
              />
            </Suspense>
          ) : null}
          <div hidden={mainPanel !== null || view === "settings"} className="contents">
            {refusal === null ? null : <RepositoryRefused code={responseCode(refusal)} result={refusal.result as RegistrationResult | undefined} onOpenRepository={() => void openRepository()} />}
            {saveFailed ? <SaveFailedNotice /> : null}
            {state.repository === null ? (
              restoring ? (
                <Loading hasContent={false} refreshing={false} />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <StartPage bridge={bridge} busy={false} onOpenFolder={() => void openRepository()} onOpened={registered} onClone={() => setMainPanel("clone")} />
                </div>
              )
            ) : (
              <>
                <HistoryFrame active={view === "history"}>{workbench}</HistoryFrame>
                {inCommitView ? (
                  <CommitView>
                    {pushPanel}
                    {commitPanel}
                  </CommitView>
                ) : null}
              </>
            )}
          </div>
          {/* plan.md "Status area": T138 fills this slot. */}
          <div data-slot="status-area" data-section={starting === null ? undefined : "statusRegion"} tabIndex={starting === null ? undefined : -1} className="shrink-0 overflow-y-auto" style={{ maxHeight: statusAreaMax }}>
            {starting === null ? null : <WslStarting name={starting.distro} operationId={starting.operationId} cancel={starting.cancelable ? cancelStart : undefined} />}
          </div>
        </main>

        <div data-section="statusRegion" tabIndex={-1} className="contents">
          <OperationStatus
            ref={statusRegion}
            bridge={bridge}
            operation={operation}
            worktreeRoot={path ?? ""}
            head={workspace?.head ?? null}
            trusted={trust?.report.trustId !== undefined}
            panel={inCommitView ? "commit" : (panel ?? "details")}
            commitPanel={commitPanelRef}
            modalOpen={modalOpen}
            refusal={paneStatus}
            onFocusMessageField={() => messageField.current?.focus()}
            onClearMessage={() => worktreeKey !== null && void drafts.clear(worktreeKey)}
            onRefresh={refresh}
            declinedFocus={submoduleOpener}
            areaMaxHeight={statusAreaMax}
            notice={statusText}
          >
            {trust === null || state.repository === null || !showsChip(trust.report) ? null : (
              <TrustChip report={trust.report} running={running} onTrust={() => void approveTrust("repository")} onStop={(trustId) => void stopTrusting(trustId)} />
            )}
            {gitVersion === null ? null : <GitSegment version={gitVersion} distro={wslGit === null ? null : distro} scope={environment?.platformScope} />}
          </OperationStatus>
        </div>
        {sync.confirm === null || pushBranch === null ? null : (
          <ForcePushConfirm plan={sync.confirm.plan} branch={pushBranch} onConfirm={sync.confirmForce} onCancel={sync.cancelForce} />
        )}
        {sync.conflictConfirm === null ? null : (
          <ConflictConfirm action={sync.conflictConfirm.action} plan={sync.conflictConfirm.plan} onConfirm={sync.confirmConflict} onCancel={sync.cancelConflict} />
        )}
        {aboutOpen && environment !== null ? (
          <AboutBoundary onClose={() => setAboutOpen(false)}>
            <Suspense fallback={null}>
              <AboutMount
              open
              scope={environment.platformScope}
              build={environment.buildIdentity}
              client={client}
              finalFocus={helpTrigger}
              onClose={() => setAboutOpen(false)}
            />
            </Suspense>
          </AboutBoundary>
        ) : null}
        {branches.overlays}
        {worktrees.overlays}
        {ignoreState.discard === null ? null : <DiscardConfirm file={ignoreState.discard.file} onKeep={ignore.keepEditing} onDiscard={ignore.discard} />}
        {keepPool ? (
          <Suspense fallback={null}>
            <PatchPool>{null}</PatchPool>
          </Suspense>
        ) : null}
      </div>
    </CopyFailed>
  );
}
