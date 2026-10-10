// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FocusEvent, type ReactNode } from "react";
import type { Environment, RegistrationResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import type { BridgeResponse, createBridge } from "../bridge";
import { ChangesPane as ChangesList } from "../changes/ChangesPane";
import { ComparisonView as Comparison, resultOf, showsDiff } from "../changes/ComparisonView";
import { Button } from "../components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { branchName, HistoryView as History } from "../history/HistoryView";
import { createShortcutHandler, type Mode } from "../keyboard/shortcuts";
import { chooseProfile, clampPanes, FILE_LANE, headerRows, metrics, paneBounds, UnmeasuredLayoutError, workAreaHeight, type Density, type Profile, type Size } from "../layout/profiles";
import { Splitter } from "../layout/Splitter";
import { splitPath, WINDOWS_SEPARATORS } from "../lib/path";
import { createRequests, isRegistration, type RequestBridge, type Requests, type RequestState } from "../state/requests";
import { DEFAULT_PREFERENCES, readPreferences, writePreferences, type Preferences, type Theme } from "../state/preferences";
import { SaveFailedNotice, TrustDialog, type TrustReport } from "../trust/TrustDialog";
import { blockingText, NoticeBand, WarningIcon } from "./NoticeBand";
import { RepositoryMenu } from "./RepositoryMenu";
import { codeText, COPY_FAILED_TEXT, CopyFailed, ErrorState, LimitedOutput, Loading, RepositoryRefused } from "./RepositoryStates";
import { hasMarkers, RecoveryMarkers } from "../boot/BootView";

// plan.md "Two feasible layouts" (layout A), "Chosen layout, sizes, and DPI", "Keyboard and focus", and "Required visible states".

type Bridge = ReturnType<typeof createBridge>;
export type WorkbenchBridge = RequestBridge & Pick<Bridge, "chooseRepository" | "readTrust" | "approveTrust" | "revokeTrust" | "getEnvironment" | "dismissRecoveryMarker">;
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
// The interim help line: Enter works, and Space shows the staging sentence.
export const INTERIM_HELP_LINE = `Enter shows a file. ${LATER.staging}`;

const SCOPE_LINE = "This test build covers opening repositories, status, diffs, hunk and file staging, local commits, submodule updates, and one history page.";
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

function headText(head: WorkspaceSnapshot["head"]): string {
  if (head.state === "detached") return "Detached HEAD";
  if (head.state === "unborn") return `${branchName(head.target)}, no commits yet`;
  return branchName(head.target);
}

/** A middle ellipsis: the start shrinks with an end ellipsis, and the tail stays whole. The full text stays the accessible name. */
function MiddleEllipsis({ text, tail, className }: { text: string; tail: string; className?: string }) {
  const head = text.slice(0, text.length - tail.length);
  return (
    <span className={`flex ${className ?? "min-w-0"}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="truncate">
        {head}
      </span>
      <span aria-hidden="true" className="shrink-0 whitespace-nowrap">
        {tail}
      </span>
    </span>
  );
}

// The last component of the `worktreeRoot` path, with its leading separator.
function lastComponent(path: string): string {
  const [folder, name] = splitPath(path, WINDOWS_SEPARATORS);
  return folder.slice(-1) + name;
}

// plan.md "Measurements and budgets": a ready frame needs a complete read with `recoveryState` `ready`.
const completeRead = (workspace: WorkspaceSnapshot | null) => workspace !== null && workspace.completeness.state === "complete" && workspace.recoveryState === "ready";
const responseCode = (response: BridgeResponse) => (response.code ?? response.state) as ErrorCode;
const refuseFileAction = async () => ({ state: "refused" as const, text: LATER.staging });

/** The T133 changes pane on the T132 request state. File staging stays refused until T148 mounts T202. */
export function ChangesPaneMount({ state, requests, menuOpen, modalOpen, onStatus }: WorkbenchPaneProps) {
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

/** The T144 History list and inspector. The commit selection is view state. A repository open clears it, and a refresh keeps it while the new page holds it. */
export function HistoryViewMount({ state, requests, density, profile, textScale }: WorkbenchPaneProps) {
  // Each `open` sets a new `repository` object, also for the same `repositoryId` (contract §6 "Registration reuse and release": a matching registration returns the same ID).
  const [selected, setSelected] = useState({ repository: state.repository, oid: null as string | null });
  const page = state.history;
  const kept = selected.repository === state.repository && (page === null || page.rows.some((row) => row.oid === selected.oid)) ? selected.oid : null;
  if (selected.repository !== state.repository || kept !== selected.oid) setSelected({ repository: state.repository, oid: kept });
  const onSelect = (oid: string) => setSelected({ repository: state.repository, oid });
  if (state.history === null) {
    if (state.historyFailure !== null) return <ErrorState code={responseCode(state.historyFailure)} result={state.historyFailure.result} onRefresh={requests.refresh} />;
    return <Loading hasContent={false} refreshing={false} />;
  }
  const entries = state.workspace?.completeness.state === "complete" ? state.entries : null;
  return <History page={state.history} entries={entries} selectedOid={kept} onSelect={onSelect} density={density} profile={profile} textScale={textScale} />;
}

// Contract §3 `readTrust`: only a `TrustReport` has `fingerprint`.
const isTrustReport = (value: unknown): value is TrustReport => typeof value === "object" && value !== null && typeof (value as { fingerprint?: unknown }).fingerprint === "string";

export function Workbench({ bridge, ChangesPane, ComparisonView, HistoryView, environment: given = null, restored, session = 0, onSelectGit = () => {}, onEnvironment, textScale = 1 }: WorkbenchProps) {
  const [requests] = useState(() => createRequests({ bridge }));
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
  // The shared bottom region height lives for the session only. Preferences store only `panes.fileLane`.
  const [bottom, setBottom] = useState<number | null>(null);
  const [fileBand, setFileBand] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  // A refused `chooseRepository` or `restoreWorkspace`. The workspace stays unchanged.
  const [refusal, setRefusal] = useState<BridgeResponse | null>(null);
  const [restoring, setRestoring] = useState(restored !== undefined);
  const [trust, setTrust] = useState<{ report: TrustReport; open: boolean } | null>(null);
  const [trustRead, setTrustRead] = useState(0);
  // A trust failure or a copy failure. It shows in the first live element of the status bar until the next notice or repository.
  const [notice, setNotice] = useState<ReactNode>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [paneStatus, setPaneStatus] = useState<string | null>(null);
  const modalOpen = trust?.open === true;
  const opener = useRef<HTMLButtonElement>(null);
  const menubar = useRef<HTMLDivElement>(null);
  const beforeMenu = useRef<HTMLElement | null>(null);
  const live = useRef({ requests, menuOpen, modalOpen, repository: state.repository });
  live.current = { requests, menuOpen, modalOpen, repository: state.repository };

  useEffect(() => () => requests.dispose(), [requests]);

  function registered(response: BridgeResponse) {
    // Contract §3: a canceled dialog, or no stored last repository, keeps the workspace.
    if (response.state === "canceled") return;
    if (response.state === "succeeded" && isRegistration(response.result)) {
      setRefusal(null);
      setSaveFailed(false);
      requests.open(response.result);
    } else setRefusal(response);
  }

  useEffect(() => {
    if (restored === undefined) return;
    let current = true;
    void restored.then((response) => {
      if (!current) return;
      setRestoring(false);
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

  // plan.md "Measurements and budgets": one mark in the next frame after each ready state commits.
  // The History-ready state needs the counts of a complete read. A selected commit does not block the mark, because a History refresh keeps the selection.
  const marked = useRef({ history: 0, changes: 0 });
  const readReady = completeRead(state.workspace) && !state.refreshing;
  const historyReady = state.mode === "history" && state.history !== null && readReady;
  const changesReady = state.mode === "changes" && readReady;
  useEffect(() => {
    if (!historyReady || marked.current.history === state.historyEpoch) return;
    const epoch = state.historyEpoch;
    const frame = requestAnimationFrame(() => {
      marked.current.history = epoch;
      performance.mark("arbareto:history-painted");
    });
    return () => cancelAnimationFrame(frame);
  }, [historyReady, state.historyEpoch]);
  useEffect(() => {
    if (!changesReady || marked.current.changes === state.changesEpoch) return;
    const epoch = state.changesEpoch;
    const frame = requestAnimationFrame(() => {
      marked.current.changes = epoch;
      performance.mark("arbareto:changes-ready");
    });
    return () => cancelAnimationFrame(frame);
  }, [changesReady, state.changesEpoch]);

  // One page-level shortcut handler (plan.md "Keyboard and focus").
  useEffect(() => {
    const handle = createShortcutHandler();
    const onKey = (event: KeyboardEvent) => {
      const { requests, menuOpen, modalOpen, repository } = live.current;
      const action = handle(event, { messageField: null, comparisonPane: null, modalOpen, menuOpen: menuOpen !== null, reviewValid: false });
      if (!action) return;
      if (action.type === "focusMenuBar") menubar.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      else if (action.type === "refresh") requests.refresh();
      else if (action.type === "selectMode" && repository) requests.setMode(action.mode);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  async function openRepository() {
    registered(await bridge.chooseRepository());
    opener.current?.focus();
  }

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

  const workspace = state.workspace;
  const path = workspace?.identity.worktreeRoot ?? null;
  const head = workspace ? headText(workspace.head) : null;
  const rows = headerRowCount(client.width, textScale);
  const pane: WorkbenchPaneProps = { state, requests, density: preferences.density, profile, textScale, menuOpen: menuOpen !== null, modalOpen, onStatus: setPaneStatus };
  // plan.md "Notice band": the blocking row, then the submodule row.
  const conflicted = workspace === null ? 0 : state.entries.reduce((n, e) => n + (e.category === "conflicted" ? 1 : 0), 0);
  const blockingRow = workspace !== null && blockingText(workspace.operationState, conflicted) !== null;
  const submodules = workspace?.submoduleNotice.count ?? 0;
  const bandRows = (blockingRow ? 1 : 0) + (submodules > 0 ? 1 : 0);

  // Sizes in DIPs. The work area scrolls when the sections reach their minima (plan.md "Overflow").
  // `workAreaHeight` needs a plan.md header row count, which only the wide and narrow profiles guarantee.
  const available = profile === "constrained" ? client.height : workAreaHeight(client, textScale, preferences.density);
  const tray = paneBounds("tray", { width: client.width, available, density: preferences.density, textScale });
  const band = paneBounds("fileBand", { width: client.width, available, density: preferences.density, textScale });
  // The status area is an empty slot until T138, so it takes no rows here.
  const clamped = clampPanes({ client, textScale, density: preferences.density, bandRows, statusArea: 0, fileBand: fileBand ?? band.default, tray: bottom ?? tray.default });
  const trayHeight = clamped.tray;
  const bandHeight = clamped.fileBand ?? band.default;
  // A drag shows the live lane width and saves it once, on pointer up.
  const [dragLane, setDragLane] = useState<number | null>(null);
  const lane = dragLane ?? preferences.panes.fileLane;
  const grid: CSSProperties =
    profile === "wide"
      ? {
          gridTemplateColumns: `${lane}px ${m.splitter}px minmax(0, 1fr)`,
          gridTemplateRows: `minmax(${Math.max(m.wideComparisonMin, m.wideLaneMin)}px, 1fr) ${m.splitter}px ${trayHeight}px`,
          gridTemplateAreas: '"lane laneSplit comparison" "traySplit traySplit traySplit" "tray tray tray"',
        }
      : profile === "narrow"
        ? {
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: `${bandHeight}px ${m.splitter}px minmax(${m.narrowComparisonMin}px, 1fr) ${m.splitter}px ${trayHeight}px`,
            gridTemplateAreas: '"lane" "laneSplit" "comparison" "traySplit" "tray"',
          }
        : {
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: `auto 0 ${m.constrainedRegionMin}px 0 ${trayHeight}px`,
            gridTemplateAreas: '"lane" "laneSplit" "comparison" "traySplit" "tray"',
          };
  const resizable = profile !== "constrained";
  const traySplitter = (
    <Splitter
      label="Resize bottom region"
      orientation="horizontal"
      value={trayHeight}
      min={tray.min}
      max={tray.max}
      reverse
      onChange={setBottom}
      className={resizable ? undefined : "hidden"}
    />
  );

  const statusText = state.refreshing ? "Refreshing…" : state.blocked ? "State unknown" : notice;

  return (
    <CopyFailed value={() => setNotice(COPY_FAILED_TEXT)}>
      <div data-profile={profile} className="flex h-dvh flex-col bg-canvas text-text">
        {environment !== null && hasMarkers(environment) ? (
          <div data-slot="recovery-markers" className="max-h-[40dvh] shrink-0 overflow-y-auto border-b border-divider p-2">
            <RecoveryMarkers environment={environment} onDismissMarker={dismissMarker} />
          </div>
        ) : null}
        <header className="flex flex-wrap items-center gap-x-3 border-b border-divider px-2" style={{ minHeight: "var(--h-header)" }}>
          <Button ref={opener} variant="outline" style={{ order: 1 }} onClick={() => void openRepository()}>
            Open repository
          </Button>
          <div className="flex min-w-[160px] flex-1 items-center gap-2" style={{ order: rows === 1 ? 2 : 6, flexBasis: rows === 1 ? undefined : "100%", minHeight: "var(--h-header)" }}>
            {path === null ? (
              <span className="text-muted-text">{state.repository || restoring ? "Loading…" : "No repository"}</span>
            ) : (
              <>
                <MiddleEllipsis text={path} tail={lastComponent(path)} className="min-w-[160px] shrink-[4]" />
                <span className="badge shrink-0">HEAD</span>
                <MiddleEllipsis text={head ?? ""} tail={(head ?? "").slice(-Math.ceil((head ?? "").length / 2))} className="min-w-0 shrink" />
              </>
            )}
          </div>
          <div ref={menubar} style={{ order: 3 }} onFocus={onMenubarFocus}>
            <Menubar className="h-auto border-0 p-0">
              <RepositoryMenu
                key={repositoryId}
                environment={environment}
                path={path}
                head={head}
                trustId={trust?.report.trustId ?? null}
                onOpenRepository={() => void openRepository()}
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
          <Button variant="outline" style={{ order: 5 }} disabled={!state.repository} onClick={() => requests.refresh()}>
            Refresh (F5)
          </Button>
        </header>

        <Tabs value={state.mode} onValueChange={(mode) => requests.setMode(mode as Mode)} className="gap-0">
          <TabsList variant="line" className="px-2" style={{ height: "var(--h-mode-bar)" }}>
            <TabsTrigger value="changes" disabled={!state.repository}>
              Changes (Ctrl+1)
            </TabsTrigger>
            <TabsTrigger value="history" disabled={!state.repository}>
              History (Ctrl+2)
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div data-slot="notice-band">
            {workspace === null ? null : (
              <NoticeBand
                operationState={workspace.operationState}
                conflicted={conflicted}
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
              <section className="flex flex-col items-start gap-2 p-4">
                <Button variant="outline" onClick={() => void openRepository()}>
                  Open repository
                </Button>
                <p className="text-muted-text">{SCOPE_LINE}</p>
              </section>
            )
          ) : (
            <>
              <section aria-label="Changes" hidden={state.mode !== "changes"} className="grid flex-1" style={grid}>
                <div className="min-h-0 overflow-auto" style={{ gridArea: "lane" }}>
                  <ChangesPane {...pane} />
                </div>
                <Splitter
                  label={profile === "wide" ? "Resize file lane" : "Resize file band"}
                  orientation={profile === "wide" ? "vertical" : "horizontal"}
                  value={profile === "wide" ? lane : bandHeight}
                  min={profile === "wide" ? FILE_LANE.min : band.min}
                  max={profile === "wide" ? FILE_LANE.max : band.max}
                  onChange={(value) => (profile === "wide" ? setDragLane(value) : setFileBand(value))}
                  onCommit={(value) => {
                    if (profile !== "wide") return;
                    setDragLane(null);
                    savePreferences({ ...preferences, panes: { fileLane: value } });
                  }}
                  className={resizable ? "[grid-area:laneSplit]" : "hidden"}
                />
                <div className="min-h-0 overflow-auto" style={{ gridArea: "comparison" }}>
                  <ComparisonView {...pane} />
                </div>
                <div className="[grid-area:traySplit]">{traySplitter}</div>
                <div className="min-h-0 overflow-auto border-t border-divider p-2 text-muted-text" style={{ gridArea: "tray" }}>
                  {LATER.commit}
                </div>
              </section>
              {/* HistoryView owns the list and the inspector. */}
              <section aria-label="History" hidden={state.mode !== "history"} className="flex min-h-0 flex-1 flex-col">
                <HistoryView {...pane} />
              </section>
            </>
          )}
          {/* plan.md "Status area": T138 fills this slot. */}
          <div data-slot="status-area" />
        </main>

        <footer className="flex items-center gap-2 border-t border-divider px-2" style={{ minHeight: "var(--h-status-bar)" }}>
          <span role="status" className="min-w-0 flex-1 truncate">
            {statusText}
          </span>
          <span role="status" className="min-w-0 flex-1 truncate">
            {paneStatus}
          </span>
        </footer>
        {trust === null || state.repository === null ? null : (
          <TrustDialog
            open={trust.open}
            report={trust.report}
            repositoryId={state.repository.repositoryId}
            bridge={bridge}
            client={client}
            finalFocus={() => opener.current}
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
