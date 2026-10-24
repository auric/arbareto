// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { foldAscii } from "./fold-ascii";

// Contract §6 "File facts". Microsoft Learn "Naming Files, Paths, and Namespaces", "Naming Conventions": no character of `<>:"/\|?*`,
// no U+0000 to U+001F, and no trailing space or period. So `.` and `..` fail too.
// The page reserves CON, PRN, AUX, NUL, COM1 to COM9, COM¹ to COM³, LPT1 to LPT9, and LPT¹ to LPT³, without case sensitivity.
// "NUL.txt and NUL.tar.gz are both equivalent to NUL", so the part before the first period decides.
// This module has no `process`, so the renderer can load it (tests/git/portable-imports.test.ts).
export const isWindowsComponent = (name: string) =>
  /^[^<>:"/\\|?*\u0000-\u001f]+$/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/.test(foldAscii(name));
