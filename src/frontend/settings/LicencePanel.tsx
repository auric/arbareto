// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

// 006 plan.md D12, D16 "Licence view", D17 "Licence panel". Spec FR-015.

const count = (n: number) => n.toLocaleString("en-US");

export const LICENCE_TEXTS = {
  bytes: (n: number) => (n === 1 ? "1 byte" : `${count(n)} bytes`),
  close: "Close the licence text (Esc)",
  region: (language: string) => `Licence text of ${language}`,
  readmeRegion: (language: string) => `Readme text of ${language}`,
  readme: "This dictionary has no licence file. Its readme names the licence.",
  failed: "Arbareto could not read the licence text: ",
  loading: "Arbareto reads the licence text…",
};

/** An icon button whose accessible name and tooltip differ (plan.md D17), with an unavailable reason as its description. */
export function TipButton({ icon, label, tip, reason = null, style, ...props }: Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & { icon: IconSvgElement; label: string; tip: string; reason?: string | null }) {
  const id = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              disabled={reason !== null}
              focusableWhenDisabled
              aria-describedby={reason === null ? undefined : id}
              style={{ width: "var(--h-row-button)", height: "var(--h-row-button)", ...style }}
              {...props}
            />
          }
        >
          <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        </TooltipTrigger>
        <TooltipContent>
          {tip}
          {reason === null ? null : <span className="block">{reason}</span>}
        </TooltipContent>
      </Tooltip>
      {reason === null ? null : (
        <span id={id} hidden>
          {reason}
        </span>
      )}
    </>
  );
}

export type LicenceDocument = { file: string; text: string; bytes: number };

export type LicencePanelProps = {
  name: string;
  /** The catalog `license` value as given (spec FR-015). */
  licence: string;
  /** Null while the documents load. */
  documents: readonly LicenceDocument[] | null;
  failure: ReactNode;
  onClose(): void;
};

/** One licence at a time. Each text shows as plain `textContent`, never as markup or Markdown (spec FR-015). */
export function LicencePanel({ name, licence, documents, failure, onClose }: LicencePanelProps) {
  const heading = useId();
  const first = useRef<HTMLDivElement>(null);
  // The compact Languages table replaces the focused row, so focus moves into the text when it shows.
  useEffect(() => {
    if (documents !== null) first.current?.focus();
  }, [documents]);
  const single = documents?.length === 1 ? documents[0]! : null;
  const meta = (doc: LicenceDocument) => (
    <>
      <span className="font-mono text-muted-text">{doc.file}</span>
      <span className="text-muted-text tabular-nums">{LICENCE_TEXTS.bytes(doc.bytes)}</span>
    </>
  );
  return (
    <section data-slot="licence-panel" aria-labelledby={heading} className="flex min-h-0 min-w-0 flex-col rounded-[4px] border border-divider bg-canvas">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider pr-2 pl-3">
        <h4 id={heading} className="font-semibold">
          {name}
        </h4>
        <span className="text-muted-text">{licence}</span>
        {single === null ? null : meta(single)}
        <span className="flex-1" />
        <TipButton icon={Cancel01Icon} label={LICENCE_TEXTS.close} tip={LICENCE_TEXTS.close} aria-keyshortcuts="Escape" onClick={onClose} style={{ width: "var(--h-button)", height: "var(--h-button)" }} />
      </div>
      {failure !== null ? (
        <p role="alert" className="px-3 py-2">
          {failure}
        </p>
      ) : documents === null ? (
        <p role="status" className="px-3 py-2 text-muted-text">
          {LICENCE_TEXTS.loading}
        </p>
      ) : (
        documents.map((doc, i) => (
          <div key={doc.file} className="flex min-h-0 flex-1 basis-0 flex-col">
            {single === null ? <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-1">{meta(doc)}</div> : null}
            {doc.file === "readme.md" ? (
              <p className="flex shrink-0 items-start gap-2 border-b border-divider bg-warning-fill px-3 py-2">
                <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0" />
                {LICENCE_TEXTS.readme}
              </p>
            ) : null}
            <div
              ref={i === 0 ? first : undefined}
              role="document"
              tabIndex={0}
              aria-label={doc.file === "readme.md" ? LICENCE_TEXTS.readmeRegion(name) : LICENCE_TEXTS.region(name)}
              className="min-h-0 flex-1 overflow-y-auto py-2 pr-6 pl-3 font-mono whitespace-pre-wrap select-text [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent-role"
            >
              {doc.text}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
