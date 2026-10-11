// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { CancelCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createContext, useContext, type ReactNode } from "react";
import type { Comparison, Completeness, RegistrationResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import type { BridgeResponse } from "../bridge";
import { Button } from "../components/ui/button";
import { HELP_LINE } from "../changes/ChangesPane";
import { LIMITATION_TEXT } from "../changes/limitation-text";
import { blockingText, WarningIcon } from "./NoticeBand";
import { RecentList, type RecentListProps } from "./RepositorySwitcher";

// plan.md "Required visible states": Repository refused, Starting WSL distro, Loading, No selection, Conflicted/unfinished operation, Error, Limited output, Large history, and Unsupported/binary.
// No state offers repair, a configuration change, or lock removal.

type Remedy = { text?: string; command?: string | null };

function ErrorIcon() {
  return <HugeiconsIcon icon={CancelCircleIcon} size="1em" strokeWidth={2} aria-hidden="true" className="shrink-0 text-removed" />;
}

// plan.md "Required visible states", status and fallback texts.
export const COPY_FAILED_TEXT = "Copy failed. Select the text and copy it with Ctrl+C.";
/** Receives each failed clipboard write. The workbench shows `COPY_FAILED_TEXT` in the status bar. */
export const CopyFailed = createContext<() => void>(() => {});

/** Copies with the web clipboard API. The app has no clipboard plugin (research.md R9, T006). */
export function useCopy(): (text: string) => void {
  const failed = useContext(CopyFailed);
  return (text) => {
    // `navigator.clipboard` is absent outside a secure context, so the call can throw before it returns a promise.
    try {
      navigator.clipboard.writeText(text).catch(() => failed());
    } catch {
      failed();
    }
  };
}

export function CopyButton({ text, children }: { text: string; children: string }) {
  const copy = useCopy();
  return (
    <Button variant="outline" size="sm" onClick={() => copy(text)}>
      {children}
    </Button>
  );
}

function Code({ children }: { children: string }) {
  return <code className="break-all">{children}</code>;
}

/** A status text that ends in a code: `<text><code>.` The code shows in the code font. */
export function codeText(text: string, code: string): ReactNode {
  return (
    <>
      {text}
      <Code>{code}</Code>.
    </>
  );
}

function CommandRemedy({ remedy }: { remedy: Remedy | undefined }) {
  if (!remedy) return null;
  return (
    <>
      {remedy.text === undefined ? null : <p>{remedy.text}</p>}
      {remedy.command ? (
        <div className="flex flex-wrap items-center gap-2">
          <Code>{remedy.command}</Code>
          <CopyButton text={remedy.command}>Copy command</CopyButton>
        </div>
      ) : null}
    </>
  );
}

function OutputTail({ text }: { text: string }) {
  return (
    <pre tabIndex={0} className="max-h-48 overflow-auto rounded-sm border border-divider p-2 whitespace-pre-wrap">
      {text}
    </pre>
  );
}

const field = <T,>(value: unknown, name: string): T | undefined => (typeof value === "object" && value !== null ? ((value as Record<string, unknown>)[name] as T | undefined) : undefined);

// The shell rejects a failed folder dialog call with `PICKER_FAILED` and no result.
export const PICKER_FAILED_TEXT = "The folder dialog failed. Open the folder again.";

/** A refused `chooseRepository` or `restoreWorkspace`. The current workspace stays unchanged. */
export function RepositoryRefused({ code, result, onOpenRepository }: { code: ErrorCode; result: RegistrationResult | undefined; onOpenRepository(): void }) {
  const text = field<string>(result, "text") ?? (code === "PICKER_FAILED" ? PICKER_FAILED_TEXT : undefined);
  return (
    <section role="alert" className="flex flex-col items-start gap-2 p-4">
      <p className="flex items-center gap-2">
        <ErrorIcon />
        <span>
          The repository did not open: <Code>{code}</Code>
        </span>
      </p>
      {code === "REPOSITORY_UNAVAILABLE" ? (
        // Contract §6 "Registration bootstrap": the selected folder, the remedy text without a command, and Git's output tail.
        <>
          {field<string>(result, "path") === undefined ? null : <Code>{field<string>(result, "path")!}</Code>}
          {field<Remedy>(result, "remedy")?.text === undefined ? null : <p>{field<Remedy>(result, "remedy")!.text}</p>}
          {field<string>(result, "outputTail") ? <OutputTail text={field<string>(result, "outputTail")!} /> : null}
        </>
      ) : (
        <>
          {text === undefined ? null : <p>{text}</p>}
          {field<string>(result, "detail") ? <OutputTail text={field<string>(result, "detail")!} /> : null}
          <CommandRemedy remedy={field<Remedy>(result, "remedy") ?? (field<string>(result, "command") ? { command: field<string>(result, "command") } : undefined)} />
        </>
      )}
      <Button variant="outline" onClick={onOpenRepository}>
        Open repository
      </Button>
    </section>
  );
}

export const SCOPE_LINE =
  "This test build covers opening repositories, recent repositories, status, diffs, hunk and file staging, local commits, submodule updates, one history page, and a read-only reference list.";

/** plan.md "Required visible states", No repository: the recent list with its filter, Open folder, and the static line. No branch per entry. */
export function StartPage(props: Omit<RecentListProps, "onClose" | "popup">) {
  return (
    <section aria-label="Start page" className="flex min-h-0 max-w-[480px] flex-col gap-4 p-4">
      <RecentList {...props} />
      <p className="text-muted-text">{SCOPE_LINE}</p>
    </section>
  );
}

export const WSL_START_CANCELED_TEXT = "WSL start canceled. The distro can keep starting.";
export const wslStartingText = (name: string) => `Starting WSL distro ${name}…`;

/** Phase `wsl-starting` of a registration or restore (contract §11 "Distro start"). The text is static: no spinner, animation, or percentage. */
export function WslStarting({ name, operationId, cancel }: { name: string; operationId: string; cancel(payload: { operationId: string }): Promise<BridgeResponse> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 p-2">
      <span>{wslStartingText(name)}</span>
      <Button variant="outline" size="sm" onClick={() => void cancel({ operationId })}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * Loading. Without content, a "Loading…" placeholder shows. With content, only a user Refresh shows the Refreshing marker.
 * `refreshing` is the T132 `RequestState.refreshing`: polls and focus-return reads never set it.
 */
export function Loading({ hasContent, refreshing }: { hasContent: boolean; refreshing: boolean }) {
  if (!hasContent) return <p className="p-2 text-muted-text">Loading…</p>;
  return refreshing ? <span className="text-muted-text">Refreshing…</span> : null;
}

/** The comparison pane without a selected entry. */
export function NoSelection({ helpLine = HELP_LINE }: { helpLine?: string }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <p>Select a file to view its changes</p>
      <p className="text-muted-text">{helpLine}</p>
    </div>
  );
}

/** A conflict or an unfinished operation. Mutations stay blocked. Refresh follows an external resolution. */
export function ConflictedState({ operationState, conflicted, onRefresh }: { operationState: WorkspaceSnapshot["operationState"]; conflicted: number; onRefresh(): void }) {
  const text = blockingText(operationState, conflicted);
  if (text === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 p-2">
      <WarningIcon />
      <span>{text}</span>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        Refresh (F5)
      </Button>
    </div>
  );
}

/** An error beside the affected pane. `LOCKED` shows the Git-resolved lock path and the contract §9 remedy text from the result. */
export function ErrorState({ code, result, onRefresh }: { code: ErrorCode; result: unknown; onRefresh(): void }) {
  const remedy = field<Remedy>(result, "remedy");
  const lockPath = code === "LOCKED" ? field<string>(result, "path") : undefined;
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-2">
      <p className="flex items-center gap-2">
        <ErrorIcon />
        <Code>{code}</Code>
      </p>
      {lockPath === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Code>{lockPath}</Code>
          <CopyButton text={lockPath}>Copy path</CopyButton>
        </div>
      )}
      {code === "LOCKED" ? remedy?.text === undefined ? null : <p>{remedy.text}</p> : <CommandRemedy remedy={remedy} />}
      <Button variant="outline" size="sm" onClick={onRefresh}>
        Refresh (F5)
      </Button>
    </div>
  );
}

/** A `limited` read. It names the code and the reached contract §5 bound, and it never reads as complete. */
export function LimitedOutput({ completeness }: { completeness: Completeness }) {
  if (completeness.state !== "limited") return null;
  return (
    <p className="flex items-center gap-2 p-2">
      <WarningIcon />
      <span>
        Incomplete: <Code>{completeness.code}</Code>
        {completeness.reason === undefined ? "" : ` ${completeness.reason}`}. Changes that depend on this view stay blocked.
      </span>
    </p>
  );
}

export const SCOPE_TEXT = "Up to 100 commits";

/** The History scope limit: one page of the current checkout, without pagination or a total count. */
export function LargeHistory() {
  return <p className="p-2 text-muted-text">{SCOPE_TEXT}</p>;
}

/**
 * An unsupported or binary comparison. It shows the plan.md "Limitation text" sentence for the contract `support` reason. Only an entry that `applyFile` refuses shows the service remedy with Copy command.
 * `fileAction` `stage` or `unstage` means that `applyFile` accepts the entry.
 */
export function UnsupportedState({ support, fileAction, remedy }: Pick<Comparison, "support" | "fileAction" | "remedy">) {
  const refused = fileAction !== "stage" && fileAction !== "unstage";
  return (
    <div className="flex flex-col items-start gap-2 p-2">
      {support === null || support === "supported" ? null : (
        <p className="flex items-center gap-2">
          <WarningIcon />
          <span>{LIMITATION_TEXT[support]}</span>
        </p>
      )}
      {refused ? <CommandRemedy remedy={remedy ?? undefined} /> : null}
    </div>
  );
}
