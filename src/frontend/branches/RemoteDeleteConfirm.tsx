// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { AlertConfirm } from "../changes/RevertConfirm";
import { shortRef } from "../refs/ReferencesSidebar";
import { LeaseCommits, type ForcePlan } from "../sync/ForcePushConfirm";
import { RD } from "./texts";

// Feature 011 spec FR-006, plan.md D2 and D13 (X2 to X8, X30), and the approved boards Remote-confirm-lost, -none, and -long.

export type RemoteDeletePlan = ForcePlan;

/** The alert dialog of a remote branch delete. Cancel has the first focus, and no button is the default (FR-006). */
export function RemoteDeleteConfirm({ plan, onConfirm, onCancel }: { plan: RemoteDeletePlan; onConfirm(): void; onCancel(): void }) {
  const { destination, lease } = plan;
  const tracking = shortRef(lease.trackingRef);
  return (
    <AlertConfirm
      title={RD.title(tracking)}
      body={
        <span className="[overflow-wrap:anywhere]">
          {RD.deletesLead}
          <code>{destination.ref}</code>
          {RD.deletesTail(destination.remote, tracking)}
        </span>
      }
      paths={null}
      more={null}
      notices={[RD.warning(tracking)]}
      button={RD.button}
      noUndo={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {lease.count > 0 ? (
        <>
          <p className="[overflow-wrap:anywhere]">{RD.lost(lease.count)}</p>
          <LeaseCommits lease={lease} label={RD.list(tracking)} />
        </>
      ) : (
        <p className="[overflow-wrap:anywhere]">{RD.noneLost(tracking)}</p>
      )}
    </AlertConfirm>
  );
}
