// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { posix, win32 } from "node:path";
import { hasDosDrivePrefix } from "./drive-prefix";
import { foldAscii } from "./fold-ascii";
import { isWindowsComponent } from "./windows-name";

// Contract §6 "Channel frames": the native path rules. Shared code takes every platform path rule from this module.
export const PATH_RULES = {
  windows: {
    // Microsoft Learn "File path formats on Windows systems": a drive letter and a separator, or a UNC server and share.
    // Rust `Path::is_absolute` needs a nonempty server and share. `win32.isAbsolute` accepts `\x` and `\\?\C:\x`, so it cannot serve here.
    // The same page names the `\\.\` and `\\?\` device paths. A device such as a pipe can block a read without end.
    isAbsolute: (path: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![.?][\\/])[^\\/]+[\\/][^\\/])/.test(path),
    // Contract §7 "Inside and outside". The same page: a UNC path and the `\\.\` and `\\?\` device paths start with two separators.
    isUncOrDevice: (path: string) => /^[\\/]{2}/.test(path),
    hasDrivePrefix: hasDosDrivePrefix,
    isGitExecutable: (path: string) => /[\\/]git\.exe$/i.test(path),
    // Contract §6 "File facts": the Windows name rule of `windows-name.ts`.
    isComponent: isWindowsComponent,
    // Contract §7 "Program file digests": an absolute link target is the `SubstituteName`, an NT object namespace path.
    // Sources: MS-FSCC 2.1.2.4 and 2.1.2.5 (`SubstituteName`), Microsoft Learn "Naming Files, Paths, and Namespaces", "NT Namespaces".
    // `\??\X:\…` maps to `X:\…`, and `\??\UNC\server\share\…` maps to `\\server\share\…`. Every other form gives null.
    linkTarget: (target: string): string | null => {
      const drive = /^\\\?\?\\([A-Za-z]:\\.*)$/s.exec(target);
      if (drive) return drive[1]!;
      const unc = /^\\\?\?\\UNC(\\[^\\/]+\\[^\\/]+(?:\\.*)?)$/s.exec(target);
      return unc ? `\\${unc[1]}` : null;
    },
    gitName: "git.exe",
    separator: /[\\/]/,
    path: win32,
    fold: foldAscii,
    // Git for Windows `find_hook` with `STRIP_EXTENSION` (hook.c, config.mak.uname): `<event>`, then `<event>.exe`.
    hookSuffixes: ["", ".exe"],
    // Git for Windows `lookup_prog` (compat/mingw.c): `<entry>\<name>.exe`, then `<entry>\<name>`. A name that already ends in the suffix gets no suffix.
    programSuffixes: [".exe", ""],
    // `mingw_access` drops `X_OK`, so any existing hooks-folder entry counts. `lookup_prog` takes an existing suffixed entry, or an unsuffixed entry that is no folder.
    executeBit: false,
    // `path_lookup` (compat/mingw.c) skips an empty `PATH` entry.
    emptyPathEntry: null,
    // `handle_long_path` (compat/mingw.c): without `core.longpaths`, an absolute path of MAX_PATH (260) UTF-16 units or more gives ENAMETOOLONG.
    gitPathUnitLimit: 260,
  },
  posix: {
    // POSIX has no device prefix. A port must refuse FIFOs and devices by their file type.
    isAbsolute: (path: string) => posix.isAbsolute(path),
    // POSIX has no UNC or device prefix.
    isUncOrDevice: (_path: string) => false,
    // git-compat-util.h: `has_dos_drive_prefix` is 0 outside Windows.
    hasDrivePrefix: (_path: string) => false,
    isGitExecutable: (path: string) => path.endsWith("/git"),
    // POSIX.1-2024 XBD 3.146 "Filename": no `/` and no NUL. The filenames dot and dot-dot have a special meaning.
    isComponent: (name: string) => name !== "." && name !== ".." && /^[^/\u0000]+$/.test(name),
    // POSIX.1-2024 XBD 4.16 "Pathname Resolution": a link text that begins with a slash is an absolute pathname.
    linkTarget: (target: string): string | null => (posix.isAbsolute(target) ? target : null),
    gitName: "git",
    separator: /\//,
    path: posix,
    fold: (path: string) => path,
    hookSuffixes: [""],
    programSuffixes: [""],
    // hook.c `find_hook` lists an entry when `access(X_OK)` succeeds. run-command.c `is_executable` takes a regular file with the owner execute bit.
    executeBit: true,
    // run-command.c `locate_in_PATH`: an empty `PATH` entry is the current folder.
    emptyPathEntry: ".",
    // POSIX Git has no MAX_PATH limit.
    gitPathUnitLimit: null,
  },
} as const;

// The renderer imports only contract types. WebView2 has no `process`.
export const isWindows = process.platform === "win32";
export const NATIVE = isWindows ? PATH_RULES.windows : PATH_RULES.posix;
