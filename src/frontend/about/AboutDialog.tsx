// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useRef, type KeyboardEvent, type RefObject } from "react";
import type { Environment } from "../../contracts/envelope";
import { SCOPE_LINE } from "../app/RepositoryStates";
import type { Notices } from "../build/notices";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { dialogSize, type Size } from "../layout/profiles";

// plan.md "About window" and "Dialog sizes". The mount passes the `bun run build:notices` output (T130) as `notices`.

// NOTICE.md lines 3, 7, and 9.
const COPYRIGHT = "Copyright (c) 2026 Ihor Lifanov";
const PERMISSION =
  "Arbareto is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.";
const NO_WARRANTY =
  "Arbareto is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.";

type OverviewProps = { scope: Environment["platformScope"]; build: Environment["buildIdentity"]; /** notices.json `repositoryUrl`. */ repositoryUrl: string };

/** The Overview panel. `build.commit` carries the `-dirty` suffix when it applies (contract `buildIdentity`). */
export function AboutOverview({ scope, build, repositoryUrl }: OverviewProps) {
  return (
    <div className="flex flex-col gap-2 select-text">
      <p className="font-heading font-semibold">Arbareto</p>
      <p>
        Build: {build.version} <span className="font-mono break-all">{build.commit}</span>
      </p>
      {build.channel === "local" && <p>Unsigned local test package</p>}
      {scope === "other" && <p>Unqualified platform</p>}
      <p>{SCOPE_LINE}</p>
      <p>{COPYRIGHT}</p>
      <p>Arbareto by Ihor Lifanov</p>
      <p>{PERMISSION}</p>
      <p>{NO_WARRANTY}</p>
      <p>License: AGPL-3.0-or-later. The License tab shows the full text.</p>
      <p>
        Corresponding Source: <span className="font-mono break-all">{repositoryUrl}</span> at commit{" "}
        <span className="font-mono break-all">{build.commit}</span>
      </p>
      {/* 006 plan.md D18 "About source line": the renderer has no link opener, so the line is text. */}
      <p>
        Hunspell source (LGPL-2.1): <span className="font-mono break-all">{`${repositoryUrl}/releases`}</span>
        {` (release ${build.version})`}
      </p>
    </div>
  );
}

export type AboutDialogProps = Omit<OverviewProps, "repositoryUrl"> & {
  notices: Notices;
  open: boolean;
  /** The main window client size in DIPs. */
  client: Size;
  /** The Help menu button. */
  finalFocus: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  onClose(): void;
};

// Each panel is the only scrolling region and one Tab stop (plan.md "Dialog sizes").
const PANEL = "min-h-0 overflow-y-auto px-4 py-2 focus-visible:ring-[3px] focus-visible:ring-ring/50";

// Plan D15 "About window": Ctrl+A selects only the shown tab panel, not the page behind the modal.
function selectPanel(event: KeyboardEvent<HTMLElement>) {
  // The Blink SelectAll key: `editing_behavior.cc` matches VK_A by `keyCode` on every layout.
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.keyCode !== 65) return;
  const panel = event.currentTarget.querySelector('[role="tabpanel"]:not([hidden])');
  if (panel === null) return;
  event.preventDefault();
  document.getSelection()?.selectAllChildren(panel);
}

export function AboutDialog({ open, scope, build, notices, client, finalFocus, onClose }: AboutDialogProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const size = dialogSize("about", client);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        initialFocus={heading}
        finalFocus={finalFocus}
        className="flex max-w-none flex-col gap-0 p-0 sm:max-w-none"
        style={{ width: size.width, height: size.height }}
        onKeyDown={selectPanel}
      >
        <DialogTitle ref={heading} tabIndex={-1} className="px-4 py-3">
          About Arbareto
        </DialogTitle>
        <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="shrink-0 px-2">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="license">License</TabsTrigger>
            <TabsTrigger value="notices">Third-party notices</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" tabIndex={0} className={PANEL}>
            <AboutOverview scope={scope} build={build} repositoryUrl={notices.repositoryUrl} />
          </TabsContent>
          <TabsContent value="license" tabIndex={0} className={PANEL}>
            <pre className="font-mono break-words whitespace-pre-wrap select-text">{`${notices.project.license}\n\n${notices.project.notice}`}</pre>
          </TabsContent>
          <TabsContent value="notices" tabIndex={0} className={PANEL}>
            {notices.groups.map((group) => (
              <section key={group.license} className="mb-4">
                <h3 className="font-heading font-semibold">{group.license}</h3>
                {group.packages.map((p) => (
                  <div key={`${p.name}@${p.version ?? ""}`} className="mt-2">
                    <h4 className="font-semibold">{p.version === undefined ? p.name : `${p.name} ${p.version}`}</h4>
                    {/* 006 plan.md D18: the fixed note, such as the Hunspell source of `hunspell-wasm`, shows beside the licence texts. */}
                    {p.note === undefined ? null : <p className="select-text">{p.note}</p>}
                    {p.files.map((file) => (
                      <pre key={file.name} className="font-mono break-words whitespace-pre-wrap select-text">
                        {notices.texts[file.text]}
                      </pre>
                    ))}
                  </div>
                ))}
              </section>
            ))}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
