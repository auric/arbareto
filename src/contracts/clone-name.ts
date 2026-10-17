// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// FR-054 and plan.md D10: the clone destination suggestion. It starts no process, reads no file, and never changes a character.

import { hasDosDrivePrefix } from "./drive-prefix";

export interface CloneNameInput {
  url: string;
  lastCloneParent: string | null;
  defaultCloneFolder: string | null;
  // The path separator of the destination platform.
  separator: "\\" | "/";
}

// `scheme://authority` holds no path segment.
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\\]*/;

// connect.c `url_is_local_not_ssh`: a colon before any slash, without a DOS drive, starts the path of an SCP-like URL.
function pathOf(url: string): string {
  const authority = AUTHORITY.exec(url);
  if (authority) return url.slice(authority[0].length);
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon) || hasDosDrivePrefix(url)) return url;
  return url.slice(colon + 1);
}

export function suggestCloneName({ url, lastCloneParent, defaultCloneFolder, separator }: CloneNameInput): string {
  const segments = pathOf(url).replace(/[/\\:]+$/, "").split(/[/\\:]/);
  const last = segments[segments.length - 1]!;
  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  const parent = lastCloneParent || defaultCloneFolder || "";
  if (parent === "") return name;
  return parent.endsWith(separator) ? parent + name : parent + separator + name;
}
