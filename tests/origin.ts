// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

export function printOrigin(specifier: string, fromDir: string): string {
  const path = Bun.resolveSync(specifier, fromDir);
  console.log(`ORIGIN ${path}`);
  return path;
}
