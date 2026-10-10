// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// research.md R9: the shipped Shiki grammars and themes. vite.config.ts points `shiki` and `@pierre/theming/themes` at modules that load only these.
// Each key is a Shiki language id. `aliases` must equal the upstream grammar aliases: Pierre resolves names such as `zsh` and `cmd` through them.

import type { LanguageRegistration, ThemeRegistrationRaw } from "shiki/core";

type Loader<T> = () => Promise<{ default: T }>;

export const LANGUAGES: Record<string, { aliases: string[]; load: Loader<LanguageRegistration[]> }> = {
  bat: { aliases: ["batch", "cmd"], load: () => import("shiki/langs/bat.mjs") },
  c: { aliases: [], load: () => import("shiki/langs/c.mjs") },
  csharp: { aliases: ["c#", "cs"], load: () => import("shiki/langs/csharp.mjs") },
  css: { aliases: [], load: () => import("shiki/langs/css.mjs") },
  diff: { aliases: [], load: () => import("shiki/langs/diff.mjs") },
  docker: { aliases: ["dockerfile"], load: () => import("shiki/langs/docker.mjs") },
  go: { aliases: [], load: () => import("shiki/langs/go.mjs") },
  html: { aliases: [], load: () => import("shiki/langs/html.mjs") },
  ini: { aliases: ["properties"], load: () => import("shiki/langs/ini.mjs") },
  java: { aliases: [], load: () => import("shiki/langs/java.mjs") },
  javascript: { aliases: ["js", "cjs", "mjs"], load: () => import("shiki/langs/javascript.mjs") },
  json: { aliases: [], load: () => import("shiki/langs/json.mjs") },
  jsonc: { aliases: [], load: () => import("shiki/langs/jsonc.mjs") },
  jsx: { aliases: [], load: () => import("shiki/langs/jsx.mjs") },
  kotlin: { aliases: ["kt", "kts"], load: () => import("shiki/langs/kotlin.mjs") },
  make: { aliases: ["makefile"], load: () => import("shiki/langs/make.mjs") },
  markdown: { aliases: ["md"], load: () => import("shiki/langs/markdown.mjs") },
  php: { aliases: [], load: () => import("shiki/langs/php.mjs") },
  powershell: { aliases: ["ps", "ps1", "pwsh"], load: () => import("shiki/langs/powershell.mjs") },
  python: { aliases: ["py"], load: () => import("shiki/langs/python.mjs") },
  rust: { aliases: ["rs"], load: () => import("shiki/langs/rust.mjs") },
  scss: { aliases: [], load: () => import("shiki/langs/scss.mjs") },
  shellscript: { aliases: ["bash", "sh", "shell", "zsh"], load: () => import("shiki/langs/shellscript.mjs") },
  sql: { aliases: [], load: () => import("shiki/langs/sql.mjs") },
  swift: { aliases: [], load: () => import("shiki/langs/swift.mjs") },
  tsx: { aliases: [], load: () => import("shiki/langs/tsx.mjs") },
  typescript: { aliases: ["ts", "cts", "mts"], load: () => import("shiki/langs/typescript.mjs") },
  xml: { aliases: [], load: () => import("shiki/langs/xml.mjs") },
};

// plan.md "Dark palettes": two upstream foregrounds stay below 4.5:1. The theme is MIT-licensed.
// The comment color `#6a737d` reaches 2.81:1 to 3.09:1 on the palette Surface and fills; `#959da5`, the theme's own `descriptionForeground`, reaches at least 4.93:1.
// `markup.changed` draws `#ffab70` on its own `#c24e00` at 2.58:1; `#ffffff` reaches 4.79:1.
const READABLE: { foreground: string; background: string | undefined; to: string }[] = [
  { foreground: "#6a737d", background: undefined, to: "#959da5" },
  { foreground: "#ffab70", background: "#c24e00", to: "#ffffff" },
];
function readableColors(module: { default: ThemeRegistrationRaw }): { default: ThemeRegistrationRaw } {
  const theme = module.default;
  const tokenColors = theme.tokenColors?.map((rule) => {
    const fix = READABLE.find((r) => r.foreground === rule.settings.foreground?.toLowerCase() && r.background === rule.settings.background?.toLowerCase());
    return fix === undefined ? rule : { ...rule, settings: { ...rule.settings, foreground: fix.to } };
  });
  return { default: { ...theme, tokenColors } };
}

export const THEMES: Record<string, { colorScheme: "light" | "dark"; load: Loader<ThemeRegistrationRaw> }> = {
  "github-light": { colorScheme: "light", load: () => import("shiki/themes/github-light.mjs") },
  "github-dark": { colorScheme: "dark", load: () => import("shiki/themes/github-dark.mjs").then(readableColors) },
};

/** The Pierre `theme` option: the application light and dark themes. */
export const DIFF_THEME = { light: "github-light", dark: "github-dark" } as const;

// research.md R10: the grammar and theme content of Shiki 4.5.0 equals these upstream releases. notices.ts reads their vendored licence texts.
export const SHIKI_VERSION = "4.5.0";
export const TM_GRAMMARS_VERSION = "1.32.22";
export const TM_THEMES_VERSION = "1.12.12";
