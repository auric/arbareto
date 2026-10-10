// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitBranchIcon, GitCommitIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FocusEvent, type ReactNode } from "react";
import type { Environment, RecoveryStatement, RegistrationResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import type { BridgeResponse, createBridge, OnProgress } from "../bridge";
import { ChangesPane as ChangesList } from "../changes/ChangesPane";
import { ComparisonView as Comparison, resultOf, showsDiff } from "../changes/ComparisonView";
import { IconButton } from "../components/icon-button";
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
  FILE_LANE,
  headerRows,
  historyFit,
  metrics,
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
import { ReferencesSidebar } from "../refs/ReferencesSidebar";
import { createRequests, isRegistration, refsPair, wslDistro, type RequestBridge, type Requests, type RequestState } from "../state/requests";
import { DEFAULT_PREFERENCES, readPreferences, writePreferences, type Preferences, type Theme } from "../state/preferences";
import { SaveFailedNotice, TrustDialog, type TrustReport } from "../trust/TrustDialog";
import { blockingText, NoticeBand, WarningIcon } from "./NoticeBand";
import { RepositoryMenu } from "./RepositoryMenu";
import { codeText, COPY_FAILED_TEXT, CopyFailed, ErrorState, LimitedOutput, Loading, RepositoryRefused, SCOPE_LINE, StartPage, WSL_START_CANCELED_TEXT, WslStarting, wslStartingText } from "./RepositoryStates";
import { folderName, RepositorySwitcher } from "./RepositorySwitcher";
import { hasMarkers, RecoveryMarkers } from "../boot/BootView";

// plan.md "Chosen layout: one view", "Chosen layout, sizes, and DPI", "Dock region", "Keyboard and focus", and "Required visible states".

type Bridge = ReturnType<typeof createBridge>;
export type WorkbenchBridge = RequestBridge &
  Pick<Bridge, "chooseRepository" | "readTrust" | "approveTrust" | "revokeTrust" | "getEnvironment" | "dismissRecoveryMarker" | "listRecentRepositories" | "openRecentRepository" | "removeRecentRepository">;
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
};

// The places of the T145 to T147, T202, T235, and T236 controls until T148 mounts them.
export const LATER = {
  commit: "Commit is available after batch 3.",
  staging: "Hunk and file staging are available after batch 3.",
  submodules: "Update submodules is available after batch 3.",
};
// The interim help line: a click or a navigation key shows a file, and Space shows the staging sentence.
export const INTERIM_HELP_LINE = `Select a file to show its changes. ${LATER.staging}`;
// plan.md "Required visible states", No selection.
export const DOCK_HINT = "Select the Working directory row to commit, or a commit to see its details.";
const NO_REPOSITORY = "No repository open";

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];
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
const refuseFileAction = async () => ({ state: "refused" as const, text: LATER.staging });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The T133 changes pane on the T132 request state. File staging stays refused until T148 mounts T202. */
export function ChangesPaneMount({ state, requests, profile, menuOpen, modalOpen, onStatus }: WorkbenchPaneProps) {
  const workspace = state.workspace;
  const failure = state.readFailure === null ? null : <ErrorState code={responseCode(state.readFailure)} result={state.readFailure.result} onRefresh={requests.refresh} />;
  if (workspace === null) return failure ?? <Loading hasContent={false} refreshing={false} />;
  const selection = state.selection === null ? null : { entryId: state.selection.entryId, comparisonId: state.capability?.comparisonId ?? null };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {failure}
      <LimitedOutput completeness={workspace.completeness} />
      <ChangesList
        entries={state.entries}
        selection={selection}
        onSelect={requests.selectEntry}
        onFileAction={refuseFileAction}
        onStatus={onStatus}
        menuOpen={menuOpen}
        modalOpen={modalOpen}
        complete={workspace.completeness.state === "complete"}
        helpLine={INTERIM_HELP_LINE}
        sideBySide={profile !== "wide"}
      />
    </div>
  );
}

// The Pierre worker pool. It loads with the first diff and stays mounted, because Pierre ends the pool when its last provider unmounts.
const PatchPool = lazy(() => import("../changes/PatchPool"));

/** The T134 comparison view of the selected entry. The hunk controls stay unavailable until T148 mounts T145. */
export function ComparisonViewMount({ state, requests }: WorkbenchPaneProps) {
  const selected = state.selection?.entryId;
  const entry = selected === undefined ? null : (state.entries.find((e) => e.entryId === selected) ?? null);
  const response = entry !== null && state.comparison?.entryId === entry.entryId ? state.comparison : null;
  const [pool, setPool] = useState(false);
  if (!pool && showsDiff(resultOf(response))) setPool(true);
  const view = <Comparison entry={entry} response={response} selectedHunk={state.selectedHunk} onRefresh={requests.refresh} helpLine={INTERIM_HELP_LINE} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {entry === null ? null : <p className="px-2 text-muted-text">{LATER.staging}</p>}
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

// Contract §3 `readTrust`: only a `TrustReport` has `fingerprint`.
const isTrustReport = (value: unknown): value is TrustReport => typeof value === "object" && value !== null && typeof (value as { fingerprint?: unknown }).fingerprint === "string";

/** The docked panel of a history row. */
const panelOf = (selected: string | null): Panel | null => (selected === null ? null : selected === WORKING_ROW || selected === INDEX_ROW ? "commit" : "details");

// plan.md "Keyboard and focus", Pane navigation: each section element carries its name.
const SECTION_SELECTOR = "[data-section]";
const TABBABLE = 'input:not([disabled]), button:not([disabled]), textarea, [tabindex="0"], [role="option"][tabindex="0"]';

export function Workbench({ bridge, ChangesPane, ComparisonView, HistoryView, environment: given = null, restored, restoreProgress, session = 0, onSelectGit = () => {}, onEnvironment, textScale = 1 }: WorkbenchProps) {
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
  // Pane sizes in the session. Preferences store only `panes.fileLane`.
  const [bottom, setBottom] = useState<number | null>(null);
  const [fileBand, setFileBand] = useState<number | null>(null);
  const [sidebar, setSidebar] = useState<number | null>(null);
  // plan.md "Dock region": one remembered height for each panel.
  const [docks, setDocks] = useState<Partial<Record<Panel, number>>>({});
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

  const page = state.history;
  const kept = row.repository === state.repository && (row.id === null || row.id === WORKING_ROW || row.id === INDEX_ROW || page === null || page.rows.some((r) => r.oid === row.id)) ? row.id : null;
  if (row.repository !== state.repository || kept !== row.id) setRow({ repository: state.repository, id: kept, epoch: row.epoch });
  const panel = panelOf(kept);
  // A row selection docks its panel at once and starts no Git read (plan.md "Change the docked panel").
  const onSelectRow = (id: string) => setRow((r) => ({ repository: state.repository, id, epoch: r.epoch + 1 }));

  const live = useRef({ requests, menuOpen, modalOpen, switcherOpen, repository: state.repository, panel });
  live.current = { requests, menuOpen, modalOpen, switcherOpen, repository: state.repository, panel };

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
    if (repositoryId === null) return;
    let current = true;
    void bridge.readTrust({ repositoryId }).then((response) => {
      if (!current || response.state !== "succeeded" || !isTrustReport(response.result)) return;
      const report = response.result;
      const first = trustShown.current !== repositoryId;
      trustShown.current = repositoryId;
      setTrust({ report, open: first && report.approvalRequired.reads && report.state !== "approved" });
    });
    return () => void (current = false);
  }, [bridge, repositoryId, trustRead]);

  // index.css: an absent `data-theme` means System, and an absent `data-density` means Compact.
  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", preferences.theme);
    if (preferences.density === "compact") root.removeAttribute("data-density");
    else root.setAttribute("data-density", preferences.density);
  }, [preferences.theme, preferences.density]);

  const savePreferences = (next: Preferences) => {
    setPreferences(next);
    if (typeof localStorage !== "undefined") writePreferences(localStorage, next);
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

  // plan.md "Keyboard and focus", Pane navigation: F6 moves through the visible sections in the T346 order.
  function moveSection(direction: "next" | "previous") {
    const root = sections.current;
    if (!root) return;
    const present = new Map<Section, HTMLElement>();
    for (const element of root.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) if (!element.closest("[hidden]")) present.set(element.dataset.section as Section, element);
    const active = document.activeElement as HTMLElement | null;
    const current = (active?.closest<HTMLElement>(SECTION_SELECTOR)?.dataset.section as Section | undefined) ?? "header";
    const order: Section[] = ["header", "noticeHeading", "references", "historyList", "workingChanges", "staged", "comparison", "composer", "commitDetails", "statusRegion"];
    const hidden = order.filter((s) => !present.has(s));
    const target = nextSection({ panel: live.current.panel ?? "details", hidden, bandRows: present.has("noticeHeading") ? 1 : 0, status: { text: present.has("statusRegion"), toggle: false, cancel: false } }, current, direction);
    if (target === null) return;
    const element = present.get(target)!;
    const remembered = lastFocus.current.get(target);
    const focus = remembered?.isConnected && element.contains(remembered) ? remembered : target === "noticeHeading" ? element.querySelector<HTMLElement>("h2") : element.querySelector<HTMLElement>(TABBABLE);
    (focus ?? element).focus();
  }
  const onSectionFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const section = target.closest<HTMLElement>(SECTION_SELECTOR)?.dataset.section as Section | undefined;
    if (section) lastFocus.current.set(section, target);
  };

  async function openRepository() {
    registered(endStart(await bridge.chooseRepository(onStart)));
  }

  // One page-level shortcut handler (plan.md "Keyboard and focus"). The switcher popup counts as a menu.
  useEffect(() => {
    const handle = createShortcutHandler();
    const onKey = (event: KeyboardEvent) => {
      const { requests, menuOpen, modalOpen, switcherOpen } = live.current;
      const action = handle(event, { messageField: null, comparisonPane: null, modalOpen, menuOpen: menuOpen !== null || switcherOpen, commitEnabled: false });
      if (!action) return;
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
    if (response.state === "succeeded" && isTrustReport(response.result)) setTrust({ report: response.result, open: true });
    else setNotice(codeText("Trust review did not complete: ", responseCode(response)));
  }

  // The menu shows the outcome text. A new trust read gives the new trust state and trust ID.
  async function revokeTrust(trustId: string) {
    const response = await bridge.revokeTrust({ repositoryId: repositoryId! }, { trustId });
    setTrustRead((n) => n + 1);
    return response;
  }

  // Focus returns to the control that had it before the menu bar (plan.md "Keyboard and focus", Menu bar row).
  const onMenubarFocus = (event: FocusEvent<HTMLDivElement>) => {
    const from = event.relatedTarget as HTMLElement | null;
    if (from && !menubar.current?.contains(from) && !from.closest('[data-slot="menubar-content"]')) beforeMenu.current = from;
  };
  const finalFocus = () => (beforeMenu.current?.isConnected ? beforeMenu.current : true);
  const onMenuOpen = (name: string) => (open: boolean) => setMenuOpen((current) => (open ? name : current === name ? null : current));

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
  const clamped = clampPanes({ ...fit, fileBand: fileBand ?? band.default, tray: bottom ?? tray.default, dock: docks.commit });
  const history = historyFit(fit);
  const content = workArea - bandRows * m.bandRow;
  const detailsBounds = dockBounds("details", { width: client.width, available: content, density: preferences.density, textScale });
  const resizable = profile !== "constrained";
  // The dock height of the shown panel. Without a selection, the hint takes the details height.
  const dockHeight = panel === "commit" ? (clamped.dock ?? 0) : Math.min(Math.max(docks.details ?? detailsBounds.default, detailsBounds.min), detailsBounds.max);
  const listHeight = content - m.splitter - dockHeight;
  const sideBounds = profile === "constrained" ? null : sidebarBounds(profile, client.width);
  const sideWidth = sideBounds === null ? 0 : Math.min(Math.max(sidebar ?? sideBounds.default, sideBounds.min), sideBounds.max);
  const markers = environment !== null && hasMarkers(environment);
  // The work area scrolls only when the reduced pane minima do not fit, or below the recovery markers, which no floor reserves.
  const scrolls = markers || (panel === "commit" ? clamped.scrolls === true : history.scrolls);
  // The flexible row keeps its computed height only while the work area scrolls. Otherwise it absorbs a shortfall, so the fixed panes stay in view.
  const flexible = `minmax(${scrolls ? clamped.comparison : 0}px, 1fr)`;
  const statusAreaMax = statusAreaHeight({ content: Number.POSITIVE_INFINITY, client, textScale, density: preferences.density, bandRows });
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
  };
  // A drag shows the live lane width and saves it once, on pointer up.
  const [dragLane, setDragLane] = useState<number | null>(null);
  const laneBounds = paneBounds("fileLane", { width: client.width - sideWidth - m.splitter, available: workArea, density: preferences.density, textScale });
  const lane = Math.min(Math.max(dragLane ?? preferences.panes.fileLane, laneBounds.min), laneBounds.max);
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
  const gitVersion = wslGit !== null ? `Git ${wslGit.version} (WSL: ${distro})` : environment?.detectedVersion === undefined ? null : `Git ${environment.detectedVersion}`;

  const commitPanel = (
    <div hidden={panel !== "commit"} className="flex h-full min-h-0 flex-col">
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
          onChange={(value) => (profile === "wide" ? setDragLane(value) : setFileBand(value))}
          onCommit={(value) => {
            if (profile !== "wide") return;
            setDragLane(null);
            savePreferences({ ...preferences, panes: { fileLane: value } });
          }}
          className={resizable ? "[grid-area:laneSplit]" : "hidden"}
        />
        <div data-section="comparison" className="min-h-0 overflow-auto" style={{ gridArea: "comparison" }}>
          <ComparisonView {...pane} />
        </div>
        <div className="[grid-area:traySplit]">
          <Splitter label="Resize commit tray" orientation="horizontal" value={trayHeight} min={tray.min} max={tray.max} reverse onChange={setBottom} className={resizable ? undefined : "hidden"} />
        </div>
        <div data-section="composer" tabIndex={-1} className="min-h-0 overflow-auto border-t border-divider p-2 text-muted-text" style={{ gridArea: "tray" }}>
          {LATER.commit}
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
        <Splitter label="Resize references sidebar" orientation="vertical" value={sideWidth} min={sideBounds!.min} max={sideBounds!.max} onChange={setSidebar} />
        <div className="flex min-h-0 flex-col">
          <section aria-label="History" data-section="historyList" className="flex min-h-0 flex-col" style={{ flex: "0 0 auto", height: Math.max(listHeight, m.historyListMin) }}>
            <HistoryView {...pane} />
          </section>
          <Splitter
            label="Resize dock"
            orientation="horizontal"
            value={dockHeight}
            min={panel === "commit" ? (clamped.dock ?? 0) : detailsBounds.min}
            max={panel === "commit" ? content - m.splitter - m.historyListMin : detailsBounds.max}
            reverse
            onChange={(value) => setDocks((d) => ({ ...d, [panel ?? "details"]: value }))}
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
            <span data-slot="branch-text" className="flex min-w-0 shrink items-center gap-1" style={{ order: 3 }}>
              <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
              <span className="truncate">{head}</span>
            </span>
          )}
          <div ref={menubar} className="flex items-center" style={{ order: 4, flexBasis: rows === 1 ? undefined : "auto" }} onFocus={onMenubarFocus}>
            <Menubar className="h-auto border-0 p-0">
              <RepositoryMenu
                key={repositoryId}
                environment={environment}
                path={path}
                head={head}
                distro={distro}
                wslGit={wslGit}
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
                <MenubarContent finalFocus={finalFocus}>
                  <MenubarRadioGroup value={preferences.theme} onValueChange={(theme) => savePreferences({ ...preferences, theme: theme as Theme })}>
                    <MenubarLabel>Theme</MenubarLabel>
                    {THEMES.map((t) => (
                      <MenubarRadioItem key={t.value} value={t.value}>
                        {t.label}
                      </MenubarRadioItem>
                    ))}
                  </MenubarRadioGroup>
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
                      savePreferences({ ...preferences, panes: { fileLane: FILE_LANE.default } });
                      setBottom(null);
                      setFileBand(null);
                      setSidebar(null);
                      setDocks({});
                    }}
                  >
                    Reset pane sizes
                  </MenubarItem>
                </MenubarContent>
              </MenubarMenu>
              <MenubarMenu onOpenChange={onMenuOpen("help")}>
                <MenubarTrigger>Help</MenubarTrigger>
                <MenubarContent finalFocus={finalFocus}>
                  <MenubarGroup>
                    <MenubarLabel className="whitespace-normal">{SCOPE_LINE}</MenubarLabel>
                  </MenubarGroup>
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
          <div data-slot="notice-band" data-section={bandRows > 0 ? "noticeHeading" : undefined} className="shrink-0 overflow-y-auto" style={{ maxHeight: 2 * m.bandRow }}>
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

        <footer className="flex items-center gap-2 border-t border-divider px-2" style={{ minHeight: "var(--h-status-bar)" }}>
          <span role="status" className="min-w-0 flex-1 truncate">
            {statusText}
          </span>
          <span role="status" className="min-w-0 flex-1 truncate">
            {paneStatus}
          </span>
          {gitVersion === null ? null : (
            <span data-slot="git-version" className="shrink-0 text-muted-text">
              {gitVersion}
            </span>
          )}
        </footer>
        {trust === null || state.repository === null ? null : (
          <TrustDialog
            open={trust.open}
            report={trust.report}
            repositoryId={state.repository.repositoryId}
            bridge={bridge}
            client={client}
            finalFocus={() => switcher.current?.querySelector<HTMLElement>("button") ?? null}
            onCancel={() => setTrust({ ...trust, open: false })}
            onApproved={(result) => {
              setTrust({ ...trust, open: false });
              setSaveFailed(result.saveFailed);
              requests.trustApproved();
              setTrustRead((n) => n + 1);
            }}
            onFailed={(response) => setNotice(codeText("Trust approval did not complete: ", responseCode(response)))}
          />
        )}
      </div>
    </CopyFailed>
  );
}
