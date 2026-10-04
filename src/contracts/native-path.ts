// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { posix, win32 } from "node:path";
import { foldAscii } from "./fold-ascii";

// Contract §6 "Channel frames": the native path rules. Shared code takes every platform path rule from this module.
export const PATH_RULES = {
  windows: {
    // Microsoft Learn "File path formats on Windows systems": a drive letter and a separator, or a UNC server and share.
    // Rust `Path::is_absolute` needs a nonempty server and share. `win32.isAbsolute` accepts `\x` and `\\?\C:\x`, so it cannot serve here.
    // The same page names the `\\.\` and `\\?\` device paths. A device such as a pipe can block a read without end.
    isAbsolute: (path: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![.?][\\/])[^\\/]+[\\/][^\\/])/.test(path),
    isGitExecutable: (path: string) => /[\\/]git\.exe$/i.test(path),
    gitName: "git.exe",
    separator: /[\\/]/,
    path: win32,
    fold: foldAscii,
  },
  posix: {
    // POSIX has no device prefix. A port must refuse FIFOs and devices by their file type.
    isAbsolute: (path: string) => posix.isAbsolute(path),
    isGitExecutable: (path: string) => path.endsWith("/git"),
    gitName: "git",
    separator: /\//,
    path: posix,
    fold: (path: string) => path,
  },
} as const;

// The renderer imports only contract types. WebView2 has no `process`.
export const isWindows = process.platform === "win32";
export const NATIVE = isWindows ? PATH_RULES.windows : PATH_RULES.posix;
