// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §6 "Startup contexts": Windows paths compare with ASCII letter folding only. `toLowerCase` also folds non-ASCII letters, such as U+212A to `k`.
export const foldAscii = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
