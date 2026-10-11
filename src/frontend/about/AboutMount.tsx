// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Notices } from "../build/notices";
import { AboutDialog, type AboutDialogProps } from "./AboutDialog";

// plan.md "Startup chunk budget": the workbench loads this module through one `lazy()` boundary, so the dialog and the notices stay out of the startup chunk.
// `bun run build:notices` writes the file before the Vite build. An eager glob puts it into this chunk. The CSP `connect-src` allows only the IPC origins, so the page cannot request the file at run time.
const notices = Object.values(import.meta.glob<Notices>("../generated/notices.json", { eager: true, import: "default" }))[0];

/** The build has no notices file. The workbench boundary shows the `NOTICES_MISSING` text. */
export class NoticesMissing extends Error {
  readonly code = "NOTICES_MISSING";
}

export default function AboutMount(props: Omit<AboutDialogProps, "notices">) {
  if (notices === undefined) throw new NoticesMissing("src/frontend/generated/notices.json is missing. Run `bun run build:notices`.");
  return <AboutDialog {...props} notices={notices} />;
}
