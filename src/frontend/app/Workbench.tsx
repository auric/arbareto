// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitBranchIcon, GitCommitIcon, RefreshIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Component, lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FocusEvent, type ReactNode, type RefObject } from "react";
import type { ChangeEntry, Comparison as ComparisonResult, Environment, RecoveryStatement, RegistrationResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import type { BridgeResponse, createBridge, OnProgress } from "../bridge";
import { ChangesPane as ChangesList, type FileAction, type FileActionResult } from "../changes/ChangesPane";
import { ComparisonView as Comparison, resultOf, showsDiff } from "../changes/ComparisonView";
import { FileControls, FileFailure, runFileAction } from "../changes/FileControls";
import { HunkControls, type Blocked, type Eligibility, type ReasonPart, type StagingTarget } from "../changes/HunkControls";
import { CommitTray } from "../commit/CommitTray";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import {
  Menubar,
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
import { CommitDetails } from "../history/CommitDetails";
import { branchName, HistoryView as History, INDEX_ROW, WORKING_ROW } from "../history/HistoryView";
import { layoutHistory } from "../history/lanes";
import { createShortcutHandler, nextSection, type Panel, type Section } from "../keyboard/shortcuts";
import {
  chooseProfile,
  clampPanes,
  dockBounds,
  headerRows,
  historyFit,
  metrics,
  overflowScroll,
  paneBounds,
  sidebarBounds,
  statusAreaHeight,
  UnmeasuredLayoutError,
  workAreaHeight,
  type Density,
  type Profile,
  type Size,
} from "../layout/profiles";
import { Splitter } from "../layout/Splitter";
import { GIT_SEPARATORS, splitPath } from "../lib/path";
import { ReferencesSidebar } from "../refs/ReferencesSidebar";
import { createRequests, isRegistration, refsPair, wslDistro, type RequestBridge, type Requests, type RequestState } from "../state/requests";
import { darkPaletteAttribute, DEFAULT_PREFERENCES, readPreferences, storePanes, writePreferences, type DarkPalette, type Panes, type Preferences, type Theme } from "../state/preferences";
import { createDrafts } from "../state/drafts";
import { createDraftStore } from "../state/draft-store";
import { OperationStatus, type StatusOperation, type StatusRegionHandle } from "../status/OperationStatus";
import { isTrustReport, SaveFailedNotice, TrustDialog, type TrustReport } from "../trust/TrustDialog";
import { blockingText, NoticeBand, WarningIcon } from "./NoticeBand";
import { MENU_CONTENT, RepositoryMenu } from "./RepositoryMenu";
import { codeText, COPY_FAILED_TEXT, CopyFailed, ErrorState, LimitedOutput, Loading, RepositoryRefused, SCOPE_LINE, StartPage, WSL_START_CANCELED_TEXT, WslStarting, wslStartingText } from "./RepositoryStates";
import { folderName, RepositorySwitcher } from "./RepositorySwitcher";
import { hasMarkers, RecoveryMarkers } from "../boot/BootView";

// plan.md "Chosen layout: one view", "Chosen layout, sizes, and DPI", "Dock region", "Keyboard and focus", and "Required visible states".

type Bridge = ReturnType<typeof createBridge>;
export type WorkbenchBridge = RequestBridge &
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
  >;
/** The hunk and file staging facts that the workbench gives the changes pane and the comparison view (T145, T202). */
export type Staging = {
  bridge: Pick<Bridge, "applyHunk" | "applyFile">;
  /** The repository and the generation of the current capability, or null. */
  target: StagingTarget | null;
  blocked: Blocked;
  trust: TrustReport | null;
  eligibility: Eligibility | undefined;
  /** The description ID of the file button. Its text is a part of the T145 reason line. */
  fileReasonId: string;
  /** The file-action reason and the Stage key reason for the reason line. */
  reasons: ReasonPart[];
  onFileReason(text: string | null): void;
  onPaneReason(text: string | null): void;
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
  /** Docks the panel of a history row. It starts no Git read. */
  onSelectRow(id: string): void;
  /** Absent in a mount without staging controls. */
  staging?: Staging;
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
  onSelectGit?(): void;
  /** Each `getEnvironment` response that the workbench reads again. */
  onEnvironment?(response: BridgeResponse): void;
  /** The Windows text scale factor (plan.md "Windows text size"). */
  textScale?: number;
  /** The draft memory (plan.md "Stored drafts"). The default stores a copy in IndexedDB. */
  drafts?: ReturnType<typeof createDrafts>;
};

// plan.md "Required visible states", No file-action decision.
export const NO_DECISION = "This entry has no file-action decision";
export const NO_DECISION_PENDING = "Its comparison is still loading.";
// The place of the T235 and T236 controls until they exist.
export const LATER = {
  submodules: "Update submodules is available after batch 3.",
};
// plan.md "Required visible states", No selection.
export const DOCK_HINT = "Select the Working directory row to commit, or a commit to see its details.";
const NO_REPOSITORY = "No repository open";

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

/** The plan.md header rows. A size without a plan.md value takes two rows, as the constrained profile does. */
function headerRowCount(width: number, textScale: number): number {
  try {
    return headerRows(width, textScale);
  } catch (error) {
    if (error instanceof UnmeasuredLayoutError) return 2;
    throw error;
  }
}

/** plan.md "Status and fallback texts": the toolbar branch text. */
function headText(head: WorkspaceSnapshot["head"]): string {
  if (head.state === "detached") return "Detached HEAD";
  if (head.state === "unborn") return `${branchName(head.target)}, no commits yet`;
  return branchName(head.target);
}

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
export function ChangesPaneMount({ state, requests, profile, menuOpen, modalOpen, onStatus, staging }: WorkbenchPaneProps) {
  const workspace = state.workspace;
  const failure = state.readFailure === null ? null : <ErrorState code={responseCode(state.readFailure)} result={state.readFailure.result} onRefresh={requests.refresh} />;
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
    const label = action.direction === "unstage" ? "Unstage file" : "Stage file";
    if (staging !== undefined && shown.entry !== null && shown.comparison?.comparisonId === action.comparisonId) return runFileAction(fileProps(staging, shown.comparison, shown.entry.category));
    return { state: "refused", text: `${label} is unavailable: ${noDecisionText(state)}` };
  };
  const controls = staging !== undefined && shown.entry !== null && shown.comparison !== null ? fileProps(staging, shown.comparison, shown.entry.category) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {failure}
      <LimitedOutput completeness={workspace.completeness} />
      <ChangesList
        entries={state.entries}
        selection={selection}
        onSelect={requests.selectEntry}
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

// The Pierre worker pool. It loads with the first diff and stays mounted, because Pierre ends the pool when its last provider unmounts.
const PatchPool = lazy(() => import("../changes/PatchPool"));

/** The T134 comparison view of the selected entry, with the T145 hunk controls in its heading. */
export function ComparisonViewMount({ state, requests, staging }: WorkbenchPaneProps) {
  const { entry, target } = shownComparison(state, staging);
  const response = entry !== null && state.comparison?.entryId === entry.entryId ? state.comparison : null;
  const [pool, setPool] = useState(false);
  if (!pool && showsDiff(resultOf(response))) setPool(true);
  const file = entry === null ? null : `${entry.category}:${entry.pathBytes}`;
  const anchor = staging?.anchor?.file === file ? staging.anchor : null;
  const controls =
    staging === undefined || entry === null
      ? undefined
      : (comparison: ComparisonResult, displayFailed: boolean) => (
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
            reasons={staging.reasons}
            onOperation={staging.onOperation}
            onEnded={(response, ordinal) => {
              if (response.state === "succeeded") staging.onHunkSucceeded(file!, ordinal, comparison.patch);
              staging.onEnded("applyHunk", response);
            }}
            stepRef={staging.stepRef}
          />
        );
  const failed = staging?.fileFailure?.file === file ? staging.fileFailure.response : null;
  const view = (
    <Comparison
      entry={entry}
      response={response}
      selectedHunk={state.selectedHunk}
      onRefresh={requests.refresh}
      controls={controls}
      anchor={anchor}
      notice={failed === null ? undefined : <FileFailure response={failed} />}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {pool ? (
          <Suspense fallback={<Loading hasContent={false} refreshing={false} />}>
            <PatchPool>{view}</PatchPool>
          </Suspense>
        ) : (
          view
        )}
      </div>
    </div>
  );
}

/** The T349 history list with the Working directory and Index rows, and the paired T359 chips. */
export function HistoryViewMount({ state, requests, density, profile, textScale, historyListMin, selected, onSelectRow }: WorkbenchPaneProps) {
  if (state.history === null) {
    if (state.historyFailure !== null) return <ErrorState code={responseCode(state.historyFailure)} result={state.historyFailure.result} onRefresh={requests.refresh} />;
    return <Loading hasContent={false} refreshing={false} />;
  }
  const entries = state.workspace?.completeness.state === "complete" ? state.entries : null;
  return <History page={state.history} entries={entries} selected={selected} onSelect={onSelectRow} density={density} profile={profile} textScale={textScale} listMin={historyListMin} refs={state.refs} />;
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

// The About dialog and the notices load on first open (plan.md "Startup chunk budget").
const AboutMount = lazy(() => import("../about/AboutMount"));

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

export function Workbench({ bridge, ChangesPane, ComparisonView, HistoryView, environment: given = null, restored, restoreProgress, session = 0, onSelectGit = () => {}, onEnvironment, textScale = 1, drafts: givenDrafts }: WorkbenchProps) {
  // plan.md "Required visible states", Recovery statement: the statement stays until the next `refresh: true` read or another repository.
  const [recovery, setRecovery] = useState<{ repositoryId: string; statement: RecoveryStatement } | null>(null);
  // Contract §11 "Distro start": a registration or restore in phase `wsl-starting`, until its response. No event marks the probe end.
  const [starting, setStarting] = useState<{ distro: string; operationId: string } | null>(null);
  // The operation that the WslStarting Cancel canceled.
  const canceledStart = useRef<string | null>(null);
  const onStart: OnProgress = (event) => {
    if (event.phase === "wsl-starting" && event.distro !== undefined) setStarting({ distro: event.distro, operationId: event.operationId });
  };
  const endStart = (response: BridgeResponse) => {
    setStarting((current) => (current !== null && current.operationId === response.operationId ? null : current));
    if (response.state === "canceled" && response.operationId !== undefined && response.operationId === canceledStart.current) setNotice(WSL_START_CANCELED_TEXT);
    return response;
  };
  const [requests] = useState(() =>
    createRequests({
      bridge: {
        restoreWorkspace: () => bridge.restoreWorkspace(onStart).then(endStart),
        readEntries: (target, payload) => bridge.readEntries(target, payload),
        readHistory: (target) => bridge.readHistory(target),
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
    }),
  );
  // The latest environment: the given one, or a later read after a dismissal or a `service-session` event.
  const [environment, setEnvironment] = useState(given);
  useEffect(() => setEnvironment(given), [given]);
  async function readEnvironment() {
    const response = await bridge.getEnvironment();
    if (response.state === "succeeded") setEnvironment(response.result as Environment);
    onEnvironment?.(response);
  }
  // Contract §6 "Dismissal": the outcome stays unknown, and the next environment read shows the remaining markers.
  const dismissMarker = (markerId: string) => void bridge.dismissRecoveryMarker({ markerId }).then(readEnvironment);
  const state = useSyncExternalStore(requests.subscribe, requests.state, requests.state);
  const [preferences, setPreferences] = useState(storedPreferences);
  const client = useClientSize();
  const profile: Profile = chooseProfile(client, textScale, preferences.density);
  const m = metrics(preferences.density, textScale);
  // A drag shows its live sizes here and stores them once, at its end. plan.md "Dock region": one remembered height for each panel.
  const [dragPanes, setDragPanes] = useState<Partial<Panes>>({});
  const panes = { ...preferences.panes, ...dragPanes };
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // A refused `chooseRepository` or `restoreWorkspace`. The workspace stays unchanged.
  const [refusal, setRefusal] = useState<BridgeResponse | null>(null);
  const [restoring, setRestoring] = useState(restored !== undefined);
  const [trust, setTrust] = useState<{ report: TrustReport; open: boolean } | null>(null);
  const [trustRead, setTrustRead] = useState(0);
  // A trust failure or a copy failure. It shows in the first live element of the status bar until the next notice or repository.
  const [notice, setNotice] = useState<ReactNode>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [paneStatus, setPaneStatus] = useState<string | null>(null);
  // The selected history row. A repository open clears it (FR-034), and a refresh keeps a commit while the new page holds it.
  const [row, setRow] = useState<{ repository: RequestState["repository"]; id: string | null; epoch: number }>({ repository: state.repository, id: null, epoch: 0 });
  const modalOpen = trust?.open === true;
  const switcher = useRef<HTMLDivElement>(null);
  const menubar = useRef<HTMLDivElement>(null);
  const beforeMenu = useRef<HTMLElement | null>(null);
  const sections = useRef<HTMLDivElement>(null);
  const lastFocus = useRef(new Map<Section, HTMLElement>());
  const [drafts] = useState(() => givenDrafts ?? createDrafts(createDraftStore()));
  // The latest mutation of this repository for the status region (T138). Another repository clears it.
  const [operation, setOperation] = useState<StatusOperation | null>(null);
  const [anchor, setAnchor] = useState<Staging["anchor"]>(null);
  const [fileReason, setFileReason] = useState<string | null>(null);
  const [paneReason, setPaneReason] = useState<string | null>(null);
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
  // The pending commit trust gate (plan.md Commit row). After an approval it waits in `approvalRead` until the read that
  // `trustApproved` starts ends with any result, so the review names the snapshot after the approval (contract §3).
  // Every other dialog close resolves it as canceled.
  const trustGate = useRef<((approved: boolean) => void) | null>(null);
  const approvalRead = useRef<((approved: boolean) => void) | null>(null);
  // The dialog opener for its focus return: the commit gate, or else the switcher.
  const fromCommit = useRef(false);
  const endGate = (approved: boolean) => {
    trustGate.current?.(approved);
    trustGate.current = null;
  };
  useEffect(() => {
    if (trust?.open !== true) endGate(false);
  }, [trust?.open]);
  // The gate resolves after the commit that follows the read end, so the tray reads the props of that render.
  const [approvalEnds, setApprovalEnds] = useState(0);
  useEffect(() => {
    approvalRead.current?.(true);
    approvalRead.current = null;
  }, [approvalEnds]);

  const page = state.history;
  const kept = row.repository === state.repository && (row.id === null || row.id === WORKING_ROW || row.id === INDEX_ROW || page === null || page.rows.some((r) => r.oid === row.id)) ? row.id : null;
  if (row.repository !== state.repository || kept !== row.id) setRow({ repository: state.repository, id: kept, epoch: row.epoch });
  const panel = panelOf(kept);
  // A row selection docks its panel at once and starts no Git read (plan.md "Change the docked panel").
  const onSelectRow = (id: string) => setRow((r) => ({ repository: state.repository, id, epoch: r.epoch + 1 }));

  const statusStop = operation !== null || starting !== null;
  const live = useRef({ requests, menuOpen, modalOpen, switcherOpen, repository: state.repository, panel, statusStop, starting: starting !== null });
  live.current = { requests, menuOpen, modalOpen, switcherOpen, repository: state.repository, panel, statusStop, starting: starting !== null };

  useEffect(() => () => requests.dispose(), [requests]);

  function registered(response: BridgeResponse) {
    // Contract §3: a canceled dialog, or no stored last repository, keeps the workspace.
    if (response.state === "canceled") return;
    if (response.state === "succeeded" && isRegistration(response.result)) {
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
    requests.serviceSession();
    void readEnvironment();
  }, [session, requests]);

  // plan.md "Required visible states", Trust required/changed: the dialog shows before the first status read when reads need approval.
  // Only the first trust read of a registration opens the dialog by itself.
  const repositoryId = state.repository?.repositoryId ?? null;
  const trustShown = useRef<string | null>(null);
  useEffect(() => {
    setTrust(null);
    setNotice(null);
    endGate(false);
    if (repositoryId === null) return;
    let current = true;
    void bridge.readTrust({ repositoryId }).then((response) => {
      if (!current || response.state !== "succeeded" || !isTrustReport(response.result)) return;
      const report = response.result;
      const first = trustShown.current !== repositoryId;
      trustShown.current = repositoryId;
      if (first) fromCommit.current = false;
      setTrust({ report, open: first && report.approvalRequired.reads && report.state !== "approved" });
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
  const historyReady = page !== null && readReady;
  const pageLayout = useMemo(() => (page === null ? null : layoutHistory(page)), [page]);
  const detailsShown = panel === "details" && page !== null && page.rows.some((r) => r.oid === kept);
  const paired = page !== null && state.refs !== null && refsPair(page.head, state.refs.current);
  const marks: [boolean, () => boolean, () => void, string][] = [
    [historyReady, () => marked.current.history !== state.historyEpoch, () => void (marked.current.history = state.historyEpoch), "arbareto:history-painted"],
    [panel === "commit" && readReady, () => marked.current.commit !== row.epoch, () => void (marked.current.commit = row.epoch), "arbareto:commit-panel-ready"],
    [detailsShown, () => marked.current.details !== row.epoch, () => void (marked.current.details = row.epoch), "arbareto:details-ready"],
    [historyReady && paired, () => marked.current.refs !== state.refs, () => void (marked.current.refs = state.refs), "arbareto:refs-ready"],
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
  function moveSection(direction: "next" | "previous") {
    const root = sections.current;
    if (!root) return;
    const present = new Map<Section, HTMLElement>();
    for (const element of root.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) if (!element.closest("[hidden]")) present.set(element.dataset.section as Section, element);
    // plan.md "Status area": an empty status region is no F6 stop.
    if (!live.current.statusStop) present.delete("statusRegion");
    const active = document.activeElement as HTMLElement | null;
    const current = (active?.closest<HTMLElement>(SECTION_SELECTOR)?.dataset.section as Section | undefined) ?? "header";
    const order: Section[] = ["header", "noticeHeading", "references", "historyList", "workingChanges", "staged", "comparison", "composer", "commitDetails", "statusRegion"];
    const hidden = order.filter((s) => !present.has(s));
    const target = nextSection({ panel: live.current.panel ?? "details", hidden, bandRows: present.has("noticeHeading") ? 1 : 0, status: { text: present.has("statusRegion"), toggle: false, cancel: false } }, current, direction);
    if (target === null) return;
    const element = present.get(target)!;
    const remembered = lastFocus.current.get(target);
    if (target === "statusRegion") {
      // The WSL start Cancel, else the T138 entry rule: the area heading once after it opens, then the last target.
      const entry = (live.current.starting ? root.querySelector<HTMLElement>('[data-slot="status-area"] button') : null) ?? statusRegion.current?.entry() ?? null;
      return (entry ?? element).focus();
    }
    const focus = remembered?.isConnected && element.contains(remembered) ? remembered : target === "noticeHeading" ? element.querySelector<HTMLElement>("h2") : element.querySelector<HTMLElement>(TABBABLE);
    (focus ?? element).focus();
  }
  const onSectionFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const section = target.closest<HTMLElement>(SECTION_SELECTOR)?.dataset.section as Section | undefined;
    if (section) lastFocus.current.set(section, target);
    if (!menubar.current?.contains(target) && !target.closest('[role="menu"]')) lastOutside.current = target;
  };

  async function openRepository() {
    registered(endStart(await bridge.chooseRepository(onStart)));
  }

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
      else if (action.type === "refresh") requests.refresh();
      else if (action.type === "openFolder") void openRepository();
      else if (action.type === "openSwitcher") setSwitcherOpen(true);
      else if (action.type === "focusSection") moveSection(action.direction);
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

  async function reviewTrust() {
    if (repositoryId === null) return;
    const response = await bridge.readTrust({ repositoryId });
    if (response.state === "succeeded" && isTrustReport(response.result)) {
      fromCommit.current = false;
      setTrust({ report: response.result, open: true });
    }
    else setNotice(codeText("Trust review did not complete: ", responseCode(response)));
  }

  // The menu shows the outcome text. A new trust read gives the new trust state and trust ID.
  async function revokeTrust(trustId: string) {
    const response = await bridge.revokeTrust({ repositoryId: repositoryId! }, { trustId });
    setTrustRead((n) => n + 1);
    return response;
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
  const head = workspace ? headText(workspace.head) : null;
  const rows = headerRowCount(client.width, textScale);
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
  const bandRows = (blockingRow ? 1 : 0) + (submodules > 0 ? 1 : 0);
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
  // The smallest commit dock that the layout keeps beside the remembered file band and tray.
  const commitDockMin = clampPanes({ ...remembered, dock: 0 }).dock ?? 0;
  const history = historyFit(fit);
  const content = workArea - bandRows * m.bandRow;
  const detailsBounds = dockBounds("details", { width: client.width, available: content, density: preferences.density, textScale });
  const resizable = profile !== "constrained";
  // The dock height of the shown panel. Without a selection, the hint takes the details height.
  const dockHeight = panel === "commit" ? (clamped.dock ?? 0) : Math.min(Math.max(panes.detailsDock ?? detailsBounds.default, detailsBounds.min), detailsBounds.max);
  const listHeight = content - m.splitter - dockHeight;
  const sideBounds = profile === "constrained" ? null : sidebarBounds(profile, client.width);
  const sideWidth = sideBounds === null ? 0 : Math.min(Math.max(panes.sidebar, sideBounds.min), sideBounds.max);
  const markers = environment !== null && hasMarkers(environment);
  // The work area scrolls only when the reduced pane minima do not fit, or below the recovery markers, which no floor reserves.
  const scrolls = markers || (panel === "commit" ? clamped.scrolls === true : history.scrolls);
  // The flexible row keeps its computed height only while the work area scrolls. Otherwise it absorbs a shortfall, so the fixed panes stay in view.
  const flexible = `minmax(${scrolls ? clamped.comparison : 0}px, 1fr)`;
  const statusAreaMax = statusAreaHeight({ content: Number.POSITIVE_INFINITY, client, textScale, density: preferences.density, bandRows });

  // The states that block mutations (plan.md "Required visible states": Busy, State unknown, Conflicted/unfinished operation, Limited output).
  const running = operation !== null && operation.response === null;
  const loading = workspace === null || state.entries.length < workspace.entryCount;
  const blocked: Blocked = running ? (operation.kind === "applyFile" ? "busy" : "running") : state.blocked ? "unknown" : workspace !== null && workspace.operationState !== "normal" ? "conflicted" : null;
  const stagingBlocked: Blocked = blocked ?? (loading ? "loading" : workspace.completeness.state !== "complete" ? "incomplete" : null);
  const onEnded = (kind: "applyHunk" | "applyFile" | "commit", response: BridgeResponse) => requests.mutationEnded(kind, response);
  const staging: Staging = {
    bridge,
    target: state.repository !== null && state.capability !== null ? { repositoryId: state.repository.repositoryId, repositoryGeneration: state.capability.repositoryGeneration } : null,
    blocked: stagingBlocked,
    trust: trust?.report ?? null,
    eligibility: workspace?.hunkEligibility,
    fileReasonId,
    reasons: [
      { id: fileReasonId, text: fileReason },
      { id: paneReasonId, text: paneReason },
    ],
    onFileReason: setFileReason,
    onPaneReason: setPaneReason,
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
    historyListMin: panel === "details" || panel === null ? history.listMin : undefined,
    selected: kept,
    onSelectRow,
    staging,
  };
  const laneBounds = paneBounds("fileLane", { width: client.width - sideWidth - m.splitter, available: workArea, density: preferences.density, textScale });
  const lane = Math.min(Math.max(panes.fileLane, laneBounds.min), laneBounds.max);
  const trayHeight = clamped.tray;
  const bandHeight = clamped.fileBand ?? band.default;
  const grid: CSSProperties =
    profile === "wide"
      ? {
          gridTemplateColumns: `${lane}px ${m.splitter}px minmax(0, 1fr)`,
          gridTemplateRows: `${flexible} ${m.splitter}px ${trayHeight}px`,
          gridTemplateAreas: '"lane laneSplit comparison" "traySplit traySplit traySplit" "tray tray tray"',
        }
      : profile === "narrow"
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
  const statusText = starting !== null ? wslStartingText(starting.distro) : state.refreshing ? "Refreshing…" : state.blocked ? "State unknown" : (notice ?? (state.repository === null && !restoring ? NO_REPOSITORY : null));
  const gitVersion = wslGit?.version ?? environment?.detectedVersion ?? null;

  const commitPanel = (
    <div ref={commitPanelRef} hidden={panel !== "commit"} className="flex h-full min-h-0 flex-col">
      <h2 className="flex shrink-0 items-center px-2 font-semibold" style={{ minHeight: "var(--h-pane-heading)" }}>
        Commit
      </h2>
      <section aria-label="Commit panel" className="grid min-h-0 flex-1" style={grid}>
        <div data-section="workingChanges" className="min-h-0 overflow-auto" style={{ gridArea: "lane" }}>
          <ChangesPane {...pane} />
        </div>
        <Splitter
          label={profile === "wide" ? "Resize file lane" : "Resize file band"}
          orientation={profile === "wide" ? "vertical" : "horizontal"}
          value={profile === "wide" ? lane : bandHeight}
          min={profile === "wide" ? laneBounds.min : band.min}
          max={profile === "wide" ? laneBounds.max : band.max}
          onChange={resize(profile === "wide" ? "fileLane" : "fileBand")}
          onCommit={keepPane(profile === "wide" ? "fileLane" : "fileBand")}
          className={resizable ? "[grid-area:laneSplit]" : "hidden"}
        />
        <div ref={comparisonPane} data-section="comparison" className="min-h-0 overflow-auto" style={{ gridArea: "comparison" }}>
          <ComparisonView {...pane} />
        </div>
        <div className="[grid-area:traySplit]">
          <Splitter label="Resize commit tray" orientation="horizontal" value={trayHeight} min={tray.min} max={tray.max} reverse onChange={resize("tray")} onCommit={keepPane("tray")} className={resizable ? undefined : "hidden"} />
        </div>
        <div data-section="composer" className="min-h-0 overflow-auto border-t border-divider p-2" style={{ gridArea: "tray" }}>
          <CommitTray
            bridge={bridge}
            target={state.repository !== null && workspace !== null ? { repositoryId: state.repository.repositoryId, repositoryGeneration: workspace.generation } : null}
            snapshotId={workspace?.snapshotId ?? null}
            worktreeKey={worktreeKey}
            drafts={drafts}
            head={workspace?.head ?? null}
            staged={staged}
            status={loading ? "loading" : workspace.completeness.state !== "complete" ? "incomplete" : null}
            blocked={blocked}
            requestTrust={(report) =>
              new Promise<boolean>((resolve) => {
                endGate(false);
                trustGate.current = resolve;
                fromCommit.current = true;
                setTrust({ report, open: true });
              })
            }
            onOperation={setOperation}
            onEnded={(response) => onEnded("commit", response)}
            fieldRef={messageField}
          />
        </div>
      </section>
    </div>
  );

  const dock = (
    <>
      {commitPanel}
      {panel === "details" && page !== null && pageLayout !== null && kept !== null ? (
        <div data-section="commitDetails" className="h-full min-h-0">
          <CommitDetails page={page} layout={pageLayout} oid={kept} onSelect={onSelectRow} />
        </div>
      ) : null}
      {panel === null ? <p className="p-2 text-muted-text">{DOCK_HINT}</p> : null}
    </>
  );

  const refsSidebar = (
    <ReferencesSidebar
      refs={state.refs}
      failure={state.refsFailure}
      unpaired={state.refsUnpaired}
      loaded={new Set(page?.rows.map((r) => r.oid) ?? [])}
      onSelectCommit={onSelectRow}
      onRefresh={() => requests.refresh()}
      collapsible={profile === "constrained"}
      repository={state.repository?.worktreeKey ?? ""}
    />
  );

  const workbench =
    profile === "constrained" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* plan.md "References sidebar": expanded, the section takes the reduced pane minimum and no more height. */}
        <div data-section="references" className="shrink-0 border-b border-divider" style={{ height: "auto", maxHeight: m.reducedPaneMin }}>
          {refsSidebar}
        </div>
        <section aria-label="History" data-section="historyList" className="flex min-h-0 flex-col" style={panel === "commit" ? { flex: "0 0 auto", height: m.historyListMin + m.row } : { flex: "1 1 0" }}>
          <HistoryView {...pane} />
        </section>
        <section aria-label="Dock" className="flex min-h-0 flex-col border-t border-divider" style={panel === "commit" ? { flex: "1 1 0" } : { flex: "0 0 auto", minHeight: m.reducedPaneMin }}>
          {dock}
        </section>
      </div>
    ) : (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `${sideWidth}px ${m.splitter}px minmax(0, 1fr)` }}>
        <div data-section="references" className="min-h-0 border-r border-divider">
          {refsSidebar}
        </div>
        <Splitter label="Resize references sidebar" orientation="vertical" value={sideWidth} min={sideBounds!.min} max={sideBounds!.max} onChange={resize("sidebar")} onCommit={keepPane("sidebar")} />
        <div className="flex min-h-0 flex-col">
          <section aria-label="History" data-section="historyList" className="flex min-h-0 flex-col" style={{ flex: "0 0 auto", height: Math.max(listHeight, m.historyListMin) }}>
            <HistoryView {...pane} />
          </section>
          <Splitter
            label="Resize dock"
            orientation="horizontal"
            value={dockHeight}
            min={panel === "commit" ? commitDockMin : detailsBounds.min}
            max={panel === "commit" ? content - m.splitter - m.historyListMin : detailsBounds.max}
            reverse
            onChange={resize(panel === "commit" ? "commitDock" : "detailsDock")}
            onCommit={keepPane(panel === "commit" ? "commitDock" : "detailsDock")}
          />
          <section aria-label="Dock" className="flex min-h-0 flex-1 flex-col">
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
            <RecoveryMarkers environment={environment} onDismissMarker={dismissMarker} />
          </div>
        ) : null}
        <header data-section="header" className="flex flex-wrap items-center gap-x-2 border-b border-divider px-2" style={{ minHeight: "var(--h-header)" }}>
          <div ref={switcher} className="flex min-w-[160px] shrink items-center" style={{ order: 1, minHeight: "var(--h-header)" }}>
            <RepositorySwitcher
              bridge={bridge}
              worktreeRoot={path}
              busy={false}
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
              onOpenFolder={() => void openRepository()}
              onOpened={registered}
            />
          </div>
          {distro === null ? null : (
            <span className="flex shrink-0 items-center" style={{ order: 2 }}>
              <WslBadge distro={distro} textScale={textScale} />
            </span>
          )}
          {head === null ? null : (
            // plan.md "Header layout": the branch text takes only the width that the other items leave, so it never moves them to another row.
            // Its folder part shrinks first and its last `/` segment last (git-check-ref-format(1) hierarchy). The title and the hidden text hold the full name.
            <span data-slot="branch-text" title={head} className="flex min-w-0 items-center gap-1 whitespace-nowrap" style={{ order: 3, flex: "1 1 0px" }}>
              <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
              <span className="sr-only">{head}</span>
              {splitPath(head, GIT_SEPARATORS)[0] === "" ? null : (
                <span data-branch-part="folder" aria-hidden="true" className="min-w-0 shrink-[1000] truncate">
                  {splitPath(head, GIT_SEPARATORS)[0]}
                </span>
              )}
              <span data-branch-part="last" aria-hidden="true" className="min-w-0 truncate">
                {splitPath(head, GIT_SEPARATORS)[1]}
              </span>
            </span>
          )}
          <div ref={menubar} className="flex items-center" style={{ order: 4, flexBasis: rows === 1 ? undefined : "auto" }} onFocus={onMenubarFocus}>
            <Menubar className="h-auto border-0 p-0">
              <RepositoryMenu
                key={repositoryId}
                repositoryOpen={path !== null}
                trustId={trust?.report.trustId ?? null}
                onOpenRepository={() => void openRepository()}
                onOpenRecent={() => setSwitcherOpen(true)}
                onSelectGit={onSelectGit}
                onReviewTrust={() => void reviewTrust()}
                revokeTrust={revokeTrust}
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
                  <MenubarItem
                    onClick={() => {
                      setDragPanes({});
                      savePreferences({ ...preferences, panes: DEFAULT_PREFERENCES.panes });
                    }}
                  >
                    Reset pane sizes
                  </MenubarItem>
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
          <span className="flex items-center gap-1" style={{ order: 5 }}>
            <IconButton icon={RefreshIcon} label="Refresh" keys={{ aria: "F5", text: "F5" }} disabled={!state.repository} onClick={() => requests.refresh()} />
            {/* plan.md "Change the docked panel": Commit selects the Working directory row and focuses Working changes. */}
            <IconButton
              icon={GitCommitIcon}
              label={commitLabel}
              disabled={!state.repository}
              onClick={() => {
                onSelectRow(WORKING_ROW);
                requestAnimationFrame(() => sections.current?.querySelector<HTMLElement>('[data-section="workingChanges"] [role="option"][tabindex="0"], [data-section="workingChanges"] h2')?.focus());
              }}
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
          <div ref={bandRef} data-slot="notice-band" data-section={bandRows > 0 ? "noticeHeading" : undefined} className="shrink-0 overflow-y-auto" style={{ maxHeight: 2 * m.bandRow }}>
            {workspace === null ? null : (
              <NoticeBand
                operationState={workspace.operationState}
                conflicted={conflicted}
                recovery={recovery !== null && recovery.repositoryId === state.repository?.repositoryId ? recovery.statement : undefined}
                submoduleRow={
                  submodules > 0 ? (
                    <p className="flex items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
                      <WarningIcon />
                      <span>
                        Some submodules are not initialized or not at their recorded commit. Count: {submodules}. {LATER.submodules}
                      </span>
                    </p>
                  ) : undefined
                }
              />
            )}
          </div>
          {refusal === null ? null : <RepositoryRefused code={responseCode(refusal)} result={refusal.result as RegistrationResult | undefined} onOpenRepository={() => void openRepository()} />}
          {saveFailed ? <SaveFailedNotice /> : null}
          {state.repository === null ? (
            restoring ? (
              <Loading hasContent={false} refreshing={false} />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <StartPage bridge={bridge} busy={false} onOpenFolder={() => void openRepository()} onOpened={registered} />
              </div>
            )
          ) : (
            workbench
          )}
          {/* plan.md "Status area": T138 fills this slot. */}
          <div data-slot="status-area" data-section={starting === null ? undefined : "statusRegion"} className="shrink-0 overflow-y-auto" style={{ maxHeight: statusAreaMax }}>
            {starting === null ? null : <WslStarting name={starting.distro} operationId={starting.operationId} cancel={cancelStart} />}
          </div>
        </main>

        <div data-section="statusRegion" className="contents">
          <OperationStatus
            ref={statusRegion}
            bridge={bridge}
            operation={operation}
            worktreeRoot={path ?? ""}
            head={workspace?.head ?? null}
            trusted={trust?.report.trustId !== undefined}
            panel={panel ?? "details"}
            commitPanel={commitPanelRef}
            modalOpen={modalOpen}
            refusal={paneStatus}
            onFocusMessageField={() => messageField.current?.focus()}
            onClearMessage={() => worktreeKey !== null && void drafts.clear(worktreeKey)}
            onRefresh={() => requests.refresh()}
            areaMaxHeight={statusAreaMax}
            notice={statusText}
          >
            {gitVersion === null ? null : <GitSegment version={gitVersion} distro={wslGit === null ? null : distro} scope={environment?.platformScope} />}
          </OperationStatus>
        </div>
        {trust === null || state.repository === null ? null : (
          <TrustDialog
            open={trust.open}
            report={trust.report}
            repositoryId={state.repository.repositoryId}
            bridge={bridge}
            client={client}
            finalFocus={() => (fromCommit.current ? messageField.current : switcher.current?.querySelector<HTMLElement>("button")) ?? null}
            onCancel={() => setTrust({ ...trust, open: false })}
            onApproved={(result) => {
              approvalRead.current = trustGate.current;
              trustGate.current = null;
              setTrust({ ...trust, open: false });
              setSaveFailed(result.saveFailed);
              void requests.trustApproved().then(() => setApprovalEnds((n) => n + 1));
              setTrustRead((n) => n + 1);
            }}
            onFailed={(response) => setNotice(codeText("Trust approval did not complete: ", responseCode(response)))}
          />
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
      </div>
    </CopyFailed>
  );
}
