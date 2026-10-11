// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RecentRepositoriesResult } from "../../contracts/envelope";
import type { BridgeResponse, createBridge } from "../bridge";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { splitPath, WINDOWS_SEPARATORS } from "../lib/path";

// FR-055. plan.md "Header layout", "Long text", "Dialog sizes", "Keyboard and focus" (Repository switcher row), "Task flow and command placement" (Switch repository row),
// and "Required visible states" (No repository, Recent entry not found); contract §3 "Recent repositories" and §9.

export const BUSY_TEXT = "A Git operation is running. Wait for its result, or select Cancel.";
export const EMPTY_TEXT = "No recent repositories. Open a folder to start.";
export const NO_MATCH_TEXT = "No recent repository matches the filter.";
export const OPEN_FOLDER = "Open folder… (Ctrl+O)";
const REMOVE = "Remove from list";

type Entry = RecentRepositoriesResult["entries"][number];
export type RecentBridge = Pick<ReturnType<typeof createBridge>, "listRecentRepositories" | "openRecentRepository" | "removeRecentRepository">;
type Absent = { reason: "absent"; path: string; text: string; remedy: { text: string } };

export type RecentListProps = {
  bridge: RecentBridge;
  /** A mutation runs: the entries and Open folder stay disabled with `BUSY_TEXT`. */
  busy: boolean;
  /** Runs `chooseRepository`. */
  onOpenFolder(): void;
  /** Receives a succeeded `openRecentRepository` response. */
  onOpened(response: BridgeResponse): void;
  /** Closes the popup. The start page has none. */
  onClose?(): void;
  /** Escape and Tab close the popup. The start page keeps them native. */
  popup?: boolean;
};

/** The last folder name of a worktree root. A WSL root ends in the same name. */
export const folderName = (path: string) => splitPath(path, WINDOWS_SEPARATORS)[1];

const isSeparator = (c: string | undefined) => c === "\\" || c === "/";

/** The drive root, or the UNC root `\\server\share\`, of a Windows absolute path. */
function rootLength(path: string): number {
  if (isSeparator(path[0]) && isSeparator(path[1])) {
    let seen = 0;
    for (let i = 2; i < path.length; i++) if (isSeparator(path[i]) && ++seen === 2) return i + 1;
    return path.length;
  }
  for (let i = 0; i < path.length; i++) if (isSeparator(path[i])) return i + 1;
  return 0;
}

/** plan.md "Long text": the path keeps its root and its last folder name whole. Only the middle part gets the ellipsis. */
function PathText({ path }: { path: string }) {
  const [folder, last] = splitPath(path, WINDOWS_SEPARATORS);
  const cut = Math.min(rootLength(path), folder.length);
  const middle = folder.slice(cut);
  return (
    <span aria-hidden="true" className="flex min-w-0 whitespace-nowrap text-muted-text">
      <span data-path-part="root" className="shrink-0">
        {folder.slice(0, cut)}
      </span>
      {middle === "" ? null : (
        <span data-path-part="middle" className="min-w-0 truncate">
          {middle}
        </span>
      )}
      <span data-path-part="last" className="shrink-0">
        {last}
      </span>
    </span>
  );
}

const entryName = (e: Entry) => [folderName(e.path), e.path, ...(e.location.kind === "wsl" ? [`WSL: ${e.location.distro}`] : [])].join(", ");

const isAbsent = (result: unknown): result is Absent => typeof result === "object" && result !== null && (result as { reason?: unknown }).reason === "absent";

/** The filter, Open folder, and the recent entries. One combobox with `aria-activedescendant` over one listbox. */
export function RecentList({ bridge, busy, onOpenFolder, onOpened, onClose, popup = false }: RecentListProps) {
  const ids = { list: useId(), busy: useId(), option: useId() };
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [listCode, setListCode] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [refusal, setRefusal] = useState<{ entryId: string; response: BridgeResponse } | null>(null);
  const opening = useRef(false);

  function load() {
    void bridge.listRecentRepositories().then(take);
  }
  function take(response: BridgeResponse) {
    if (response.state === "succeeded") {
      setEntries((response.result as RecentRepositoriesResult).entries);
      setListCode(null);
    } else setListCode(response.code ?? response.state);
  }
  useEffect(load, []);

  const needle = query.toLowerCase();
  // plan.md Repository switcher row: the folder name or the path contains the text, without regard to letter case.
  const shown = (entries ?? []).filter((e) => folderName(e.path).toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle));
  const count = shown.length + 1;
  const active = Math.min(activeIndex, count - 1);
  const optionId = (index: number) => `${ids.option}-${index}`;

  async function open(entry: Entry) {
    if (busy || opening.current) return;
    opening.current = true;
    setRefusal(null);
    const response = await bridge.openRecentRepository({ entryId: entry.entryId });
    opening.current = false;
    if (response.state === "succeeded") {
      onOpened(response);
      onClose?.();
    } else setRefusal({ entryId: entry.entryId, response });
  }

  async function remove(entryId: string) {
    const response = await bridge.removeRecentRepository({ entryId });
    if (refusal?.entryId === entryId) setRefusal(null);
    // An unknown entry means a stale list. A new read shows the stored list.
    if (response.state === "succeeded") take(response);
    else load();
  }

  function activate(index: number) {
    if (busy) return;
    if (index === 0) {
      onOpenFolder();
      onClose?.();
    } else {
      const entry = shown[index - 1];
      if (entry) void open(entry);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, Math.min(count - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(active);
    } else if (event.key === "Delete") {
      // Delete has no text effect only with a collapsed caret at the end of the filter text.
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      const entry = active > 0 ? shown[active - 1] : undefined;
      if (!atEnd || entry === undefined || busy) return;
      event.preventDefault();
      void remove(entry.entryId);
    } else if (popup && (event.key === "Escape" || event.key === "Tab")) onClose?.();
  }

  const refused = refusal?.response;
  const absent = refused !== undefined && isAbsent(refused.result) ? refused.result : null;
  const empty = entries !== null && entries.length === 0;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <input
        role="combobox"
        aria-label="Filter recent repositories"
        aria-expanded="true"
        aria-controls={ids.list}
        aria-autocomplete="list"
        aria-activedescendant={optionId(active)}
        className="h-(--h-button) shrink-0 rounded-sm border border-control-border bg-surface px-2"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <p id={ids.busy} className="shrink-0 text-muted-text">
          {BUSY_TEXT}
        </p>
      ) : null}
      <div id={ids.list} role="listbox" aria-label="Recent repositories" className="min-h-0 overflow-y-auto">
        {[null, ...shown].map((entry, index) => (
          <div
            key={entry?.entryId ?? "open-folder"}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            aria-disabled={busy || undefined}
            aria-describedby={busy ? ids.busy : undefined}
            aria-label={entry === null ? undefined : entryName(entry)}
            aria-current={entry?.current ? "true" : undefined}
            className={`list-row flex min-w-0 items-center gap-2 px-2 ${index === active ? "bg-hover" : ""} ${busy ? "text-muted-text" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setActiveIndex(index);
              activate(index);
            }}
          >
            {entry === null ? (
              OPEN_FOLDER
            ) : (
              <>
                <span aria-hidden="true" className="shrink-0 font-semibold">
                  {folderName(entry.path)}
                </span>
                <PathText path={entry.path} />
                {entry.location.kind === "wsl" ? (
                  <span aria-hidden="true" className="badge ml-auto shrink-0 border-control-border">
                    WSL: {entry.location.distro}
                  </span>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>
      {entries === null && listCode === null ? <p className="text-muted-text">Loading…</p> : null}
      {listCode === null ? null : (
        <p>
          <code>{listCode}</code>
        </p>
      )}
      {empty ? <p className="text-muted-text">{EMPTY_TEXT}</p> : !empty && entries !== null && shown.length === 0 ? <p className="text-muted-text">{NO_MATCH_TEXT}</p> : null}
      {refused === undefined ? null : absent !== null ? (
        // plan.md "Required visible states", Recent entry not found: the texts come from the shell result.
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>{absent.text}</p>
          <p>{absent.remedy.text}</p>
          <Button variant="outline" size="sm" onClick={() => void remove(refusal!.entryId)}>
            {REMOVE}
          </Button>
        </div>
      ) : (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>
            The repository did not open: <code>{refused.code ?? refused.state}</code>
          </p>
          {typeof (refused.result as { text?: unknown } | undefined)?.text === "string" ? <p>{(refused.result as { text: string }).text}</p> : null}
        </div>
      )}
    </div>
  );
}

export type RepositorySwitcherProps = Omit<RecentListProps, "onClose" | "popup"> & {
  /** The worktree root of the open workspace, or null. */
  worktreeRoot: string | null;
  open: boolean;
  /** A keyboard shortcut opened the popup. Base UI sets no `data-instant` for an open without an event, so this prop sets it (plan.md "Motion"). */
  instant?: boolean;
  /** `instant` is true only for an open by Alt+Down. */
  onOpenChange(open: boolean, instant?: boolean): void;
};

/** The toolbar switcher: the button shows the open repository, and its popup holds the recent list. Ctrl+R sets `open`. */
export function RepositorySwitcher({ worktreeRoot, open, instant = false, onOpenChange, ...list }: RepositorySwitcherProps) {
  const name = worktreeRoot === null ? null : folderName(worktreeRoot);
  const label = worktreeRoot === null ? "Recent repositories" : `${name}, ${worktreeRoot}`;
  return (
    <Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={label}
                  aria-keyshortcuts="Control+R"
                  className="min-w-0 justify-start gap-2"
                  style={{ height: "var(--h-button)" }}
                  onKeyDown={(event) => {
                    if (event.altKey && event.key === "ArrowDown" && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
                      event.preventDefault();
                      onOpenChange(true, true);
                    }
                  }}
                />
              }
            />
          }
        >
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
          {worktreeRoot === null ? null : (
            <>
              <span aria-hidden="true" className="shrink-0 font-semibold">
                {name}
              </span>
              <PathText path={worktreeRoot} />
            </>
          )}
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        </TooltipTrigger>
        <TooltipContent>Recent repositories (Ctrl+R)</TooltipContent>
      </Tooltip>
      {/* plan.md "Dialog sizes": at most 480 DIPs wide and 60% of the client height, inside the client area less 16 DIPs on each side. */}
      <PopoverContent {...(instant && open ? { "data-instant": "" } : {})} align="start" className="max-h-[min(60vh,calc(100vh-32px))] w-[min(480px,calc(100vw-32px))]">
        {open ? <RecentList {...list} popup onClose={() => onOpenChange(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}
