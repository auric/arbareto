// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useSyncExternalStore } from "react";

export type DiffThemeType = "system" | "light" | "dark";

// index.css: the root `data-theme` holds View > Theme, and an absent attribute means System.
// Pierre 1.5.1 `wrapThemeCSS` sets `color-scheme` only for "light" and "dark". Its "system" keeps `color-scheme: light dark`, so the diff follows the OS as the window does.
function read(): DiffThemeType {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" || theme === "dark" ? theme : "system";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The Pierre `themeType` option for the app theme. */
export function useDiffThemeType(): DiffThemeType {
  return useSyncExternalStore(subscribe, read);
}
