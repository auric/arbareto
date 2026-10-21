// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The `unsafeCSS` of PatchView. Static CSS only. Repository content never enters it.
// plan.md "Selected hunk" and feature 004 plan.md D16: a 3 DIP Accent left bar and no fill. The focus outline stays as Pierre draws it.
export const PATCH_CSS = "[data-selected-line]{background:none;box-shadow:inset 3px 0 0 var(--accent-role)}";
