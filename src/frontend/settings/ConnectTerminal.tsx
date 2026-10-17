// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";
import { connectNoticeText, WarningIcon } from "../app/NoticeBand";
import { codeText } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { isObject } from "../lib/utils";

// Feature 003 spec FR-034 and FR-037, plan.md D9 and D12 "Connect in a terminal", O-10, and contract Δ3 `connectInTerminal`.

// Plan.md D12: the program names of `PUTTY_UNAVAILABLE` (contract Δ9 `PUTTY_PROGRAMS`).
export const PUTTY_PROGRAM_NAMES: Record<string, string> = { plink: "plink", pageant: "Pageant", puttygen: "PuTTYgen" };

/** Contract Δ9 `PUTTY_UNAVAILABLE` names the program and the path (FR-037). Another response, or a result without these fields, gives null. */
export function puttyUnavailableText(response: BridgeResponse): ReactNode {
  const r = response.result;
  if (response.code !== "PUTTY_UNAVAILABLE" || !isObject(r) || typeof r.program !== "string" || !Object.hasOwn(PUTTY_PROGRAM_NAMES, r.program) || typeof r.path !== "string" || typeof r.reason !== "string") return null;
  return (
    <>
      {`${PUTTY_PROGRAM_NAMES[r.program]} is not available: `}
      <code className="break-all">{r.path}</code>
      {` (${r.reason})`}
    </>
  );
}

function connectResultText(response: BridgeResponse): ReactNode {
  if (response.state === "succeeded") return "The terminal opened.";
  return puttyUnavailableText(response) ?? codeText("Connect in a terminal did not complete: ", response.code ?? response.state);
}

export type ConnectProps = {
  /** Sends `connectInTerminal` for the failed operation. */
  connect(): Promise<BridgeResponse>;
  /** Each band control registers here, so focus moves to the band heading when it leaves (plan.md "Notice band"). */
  bindControl?: (element: HTMLButtonElement) => () => void;
};

/** Connect in a terminal and its result. A running request blocks a second one. */
export function ConnectButton({ connect, bindControl }: ConnectProps) {
  const [result, setResult] = useState<ReactNode>(null);
  const [running, setRunning] = useState(false);
  async function run() {
    if (running) return;
    setRunning(true);
    setResult(connectResultText(await connect()));
    setRunning(false);
  }
  return (
    <>
      <Button ref={bindControl} variant="outline" size="sm" disabled={running} onClick={() => void run()}>
        <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        Connect in a terminal
      </Button>
      <span role="status">{result}</span>
    </>
  );
}

/** The notice row after a failed network `sync` under plink (O-10). It names no cause. */
export function ConnectNoticeRow({ name, onDismiss, ...props }: ConnectProps & { name: string; onDismiss(): void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <WarningIcon />
      <span>{connectNoticeText(name)}</span>
      <ConnectButton {...props} />
      <IconButton icon={Cancel01Icon} label="Dismiss notice" onClick={onDismiss} />
    </div>
  );
}
