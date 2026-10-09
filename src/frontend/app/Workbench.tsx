// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FocusEvent } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import type { BridgeResponse } from "../bridge";
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
import { createShortcutHandler, type Mode } from "../keyboard/shortcuts";
import { chooseProfile, clampPanes, FILE_LANE, headerRows, metrics, paneBounds, UnmeasuredLayoutError, workAreaHeight, type Density, type Profile, type Size } from "../layout/profiles";
import { Splitter } from "../layout/Splitter";
import { createRequests, isRegistration, type RequestBridge, type Requests, type RequestState } from "../state/requests";
import { DEFAULT_PREFERENCES, readPreferences, writePreferences, type Preferences, type Theme } from "../state/preferences";

// plan.md "Two feasible layouts" (layout A), "Chosen layout, sizes, and DPI", "Keyboard and focus", and "Required visible states".

export type WorkbenchBridge = RequestBridge & { chooseRepository(): Promise<BridgeResponse> };
/** The props that the workbench gives each injected view. */
export type WorkbenchPaneProps = { state: RequestState; requests: Requests };
export type WorkbenchProps = {
  bridge: WorkbenchBridge;
  ChangesPane: ComponentType<WorkbenchPaneProps>;
  ComparisonView: ComponentType<WorkbenchPaneProps>;
  /** T144. Without it, History shows an unavailable state. */
  HistoryView?: ComponentType<WorkbenchPaneProps>;
};

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
// The Windows text scale reaches the page through `currentSession` and the `text-scale` event (contract §2). Neither is wired here yet.
const TEXT_SCALE = 1;

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
function headerRowCount(width: number): number {
  try {
    return headerRows(width, TEXT_SCALE);
  } catch (error) {
    if (error instanceof UnmeasuredLayoutError) return 2;
    throw error;
  }
}

// Git ref names: a local branch is `refs/heads/<name>` (git-check-ref-format(1)).
const branchName = (target: string) => (target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target);
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

// The last path component, with its leading separator. A path is display text from contract §3.
function lastComponent(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index < 0 ? path : path.slice(index);
}

export function Workbench({ bridge, ChangesPane, ComparisonView, HistoryView }: WorkbenchProps) {
  const [requests] = useState(() => createRequests({ bridge }));
  const state = useSyncExternalStore(requests.subscribe, requests.state, requests.state);
  const [preferences, setPreferences] = useState(storedPreferences);
  const client = useClientSize();
  const profile: Profile = chooseProfile(client, TEXT_SCALE, preferences.density);
  const m = metrics(preferences.density, TEXT_SCALE);
  // The shared bottom region height lives for the session only. Preferences store only `panes.fileLane`.
  const [bottom, setBottom] = useState<number | null>(null);
  const [fileBand, setFileBand] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const menubar = useRef<HTMLDivElement>(null);
  const beforeMenu = useRef<HTMLElement | null>(null);
  const live = useRef({ requests, menuOpen, repository: state.repository });
  live.current = { requests, menuOpen, repository: state.repository };

  useEffect(() => () => requests.dispose(), [requests]);

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
  const marked = useRef({ history: 0, changes: 0 });
  const historyReady = state.mode === "history" && state.history !== null;
  const changesReady = state.mode === "changes" && state.workspace !== null;
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
      const { requests, menuOpen, repository } = live.current;
      const action = handle(event, { messageField: null, comparisonPane: null, modalOpen: false, menuOpen: menuOpen !== null, reviewValid: false });
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
    const response = await bridge.chooseRepository();
    // Contract §3: a canceled dialog keeps the workspace.
    if (response.state === "succeeded" && isRegistration(response.result)) {
      setOpenFailed(false);
      requests.open(response.result);
    } else if (response.state !== "canceled") setOpenFailed(true);
    opener.current?.focus();
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
  const rows = headerRowCount(client.width);
  const pane = { state, requests };

  // Sizes in DIPs. The work area scrolls when the sections reach their minima (plan.md "Overflow").
  // `workAreaHeight` needs a plan.md header row count, which only the wide and narrow profiles guarantee.
  const available = profile === "constrained" ? client.height : workAreaHeight(client, TEXT_SCALE, preferences.density);
  const tray = paneBounds("tray", { width: client.width, available, density: preferences.density, textScale: TEXT_SCALE });
  const band = paneBounds("fileBand", { width: client.width, available, density: preferences.density, textScale: TEXT_SCALE });
  // The notice band and the status area are empty slots until T137 and T138, so they take no rows here.
  const clamped = clampPanes({ client, textScale: TEXT_SCALE, density: preferences.density, bandRows: 0, statusArea: 0, fileBand: fileBand ?? band.default, tray: bottom ?? tray.default });
  const trayHeight = clamped.tray;
  const bandHeight = clamped.fileBand ?? band.default;
  const lane = preferences.panes.fileLane;
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
  const historyGrid: CSSProperties = {
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: profile === "constrained" ? `${m.constrainedRegionMin}px 0 ${trayHeight}px` : `minmax(${m.historyListMin}px, 1fr) ${m.splitter}px ${trayHeight}px`,
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

  const statusText = state.refreshing ? "Refreshing…" : state.blocked ? "State unknown" : openFailed ? "The repository did not open." : "";

  return (
    <div data-profile={profile} className="flex h-dvh flex-col bg-canvas text-text">
      <header className="flex flex-wrap items-center gap-x-3 border-b border-divider px-2" style={{ minHeight: "var(--h-header)" }}>
        <Button ref={opener} variant="outline" style={{ order: 1 }} onClick={() => void openRepository()}>
          Open repository
        </Button>
        <div className="flex min-w-[160px] flex-1 items-center gap-2" style={{ order: rows === 1 ? 2 : 6, flexBasis: rows === 1 ? undefined : "100%", minHeight: "var(--h-header)" }}>
          {path === null ? (
            <span className="text-muted-text">{state.repository ? "Loading…" : "No repository"}</span>
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
            <MenubarMenu onOpenChange={onMenuOpen("repository")}>
              <MenubarTrigger>Repository</MenubarTrigger>
              <MenubarContent finalFocus={finalFocus}>
                <MenubarGroup>
                  <MenubarLabel className="break-all whitespace-normal">{path ?? "No repository"}</MenubarLabel>
                  {head === null ? null : <MenubarLabel className="break-all whitespace-normal">HEAD: {head}</MenubarLabel>}
                </MenubarGroup>
                <MenubarSeparator />
                <MenubarItem onClick={() => void openRepository()}>Open repository</MenubarItem>
              </MenubarContent>
            </MenubarMenu>
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
        {/* plan.md "Notice band": T137 fills this slot. */}
        <div data-slot="notice-band" />
        {state.repository === null ? (
          <section className="flex flex-col items-start gap-2 p-4">
            <Button variant="outline" onClick={() => void openRepository()}>
              Open repository
            </Button>
            <p className="text-muted-text">{SCOPE_LINE}</p>
          </section>
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
                onChange={(value) => (profile === "wide" ? savePreferences({ ...preferences, panes: { fileLane: value } }) : setFileBand(value))}
                className={resizable ? "[grid-area:laneSplit]" : "hidden"}
              />
              <div className="min-h-0 overflow-auto" style={{ gridArea: "comparison" }}>
                <ComparisonView {...pane} />
              </div>
              <div className="[grid-area:traySplit]">{traySplitter}</div>
              <div className="min-h-0 overflow-auto border-t border-divider p-2 text-muted-text" style={{ gridArea: "tray" }}>
                Commit is not available in this build.
              </div>
            </section>
            <section aria-label="History" hidden={state.mode !== "history"} className="grid flex-1" style={historyGrid}>
              <div className="min-h-0 overflow-auto">
                {HistoryView ? <HistoryView {...pane} /> : <p className="p-2 text-muted-text">{state.history === null ? "Loading…" : "History is not available in this build."}</p>}
              </div>
              <div>{traySplitter}</div>
              <div className="min-h-0 overflow-auto border-t border-divider p-2 text-muted-text">Select a commit to see its details</div>
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
      </footer>
    </div>
  );
}
