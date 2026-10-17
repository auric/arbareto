// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Git for Windows compat/win32/path-utils.h `has_dos_drive_prefix`: an ASCII letter and a colon.
// This module has no runtime import and no `process`, so the renderer can load it (tests/git/portable-imports.test.ts).
export const hasDosDrivePrefix = (path: string) => /^[A-Za-z]:/.test(path);
