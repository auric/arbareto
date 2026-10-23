// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A US-layout Chromium keydown carries `keyCode`, the Windows virtual key (Blink `editing_behavior.cc` matches it).
// A to Z are 65 to 90, and the period key is VK_OEM_PERIOD, 190. The fixtures give 0 for every other key, because no handler reads it.
export function latinKeyCode(key: string): number {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return key === "." ? 190 : 0;
}
