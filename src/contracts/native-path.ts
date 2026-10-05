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
    // Contract §6 "File facts". Microsoft Learn "Naming Files, Paths, and Namespaces", "Naming Conventions": no character of `<>:"/\|?*`,
    // no U+0000 to U+001F, and no trailing space or period. So `.` and `..` fail too.
    // The page reserves CON, PRN, AUX, NUL, COM1 to COM9, COM¹ to COM³, LPT1 to LPT9, and LPT¹ to LPT³, without case sensitivity.
    // "NUL.txt and NUL.tar.gz are both equivalent to NUL", so the part before the first period decides.
    isComponent: (name: string) =>
      /^[^<>:"/\\|?*\u0000-\u001f]+$/.test(name) &&
      !/[. ]$/.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/.test(foldAscii(name)),
    gitName: "git.exe",
    separator: /[\\/]/,
    path: win32,
    fold: foldAscii,
  },
  posix: {
    // POSIX has no device prefix. A port must refuse FIFOs and devices by their file type.
    isAbsolute: (path: string) => posix.isAbsolute(path),
    isGitExecutable: (path: string) => path.endsWith("/git"),
    // POSIX.1-2024 XBD 3.146 "Filename": no `/` and no NUL. The filenames dot and dot-dot have a special meaning.
    isComponent: (name: string) => name !== "." && name !== ".." && /^[^/\u0000]+$/.test(name),
    gitName: "git",
    separator: /\//,
    path: posix,
    fold: (path: string) => path,
  },
} as const;

// The renderer imports only contract types. WebView2 has no `process`.
export const isWindows = process.platform === "win32";
export const NATIVE = isWindows ? PATH_RULES.windows : PATH_RULES.posix;
