// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The `unsafeCSS` of PatchView. Static CSS only. Repository content never enters it.
// plan.md "Selected hunk" and feature 004 plan.md D16: a 3 DIP Accent left bar and no fill. The focus outline stays as Pierre draws it.
// Feature 005 plan.md D3 "Diff scrolling": the Virtualizer is the only scroll container. @pierre/diffs 1.5.1 style.css makes `[data-code]` a horizontal scroller as tall as the rendered rows.
// `[data-code]` takes its content width, so the sticky line numbers stay inside it. `[data-diff]` becomes the size container, so `100cqi` is the pane width for annotations and separators.
export const PATCH_CSS =
  "[data-selected-line]{background:none;box-shadow:inset 3px 0 0 var(--accent-role)}" +
  "[data-diff]{container-type:inline-size}" +
  "[data-code]{overflow:clip;container-type:normal;width:max-content;min-width:100%}" +
  "[data-overflow=scroll] [data-annotation-content]{width:calc(100cqi - var(--diffs-column-number-width))}";
