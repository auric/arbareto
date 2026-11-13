// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T008: the pinned release tools (data-model §5, plan.md D2). tests/contracts/release-pins.test.ts compares each value with the files that use it.

export const PINS = {
  bun: "1.4.4",
  // https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt, line `bun-windows-x64.zip`.
  bunWindowsZipSha256: "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5",
  rust: "1.99.0",
  tauriCli: "2.12.0",
  // GitHub asset digest of `cargo-tauri-x86_64-pc-windows-msvc.zip` in release `tauri-cli-v2.12.0`. tauri-apps publishes no checksum file.
  tauriCliWindowsZipSha256: "78785c9b574bbe4bbfe6cc3008422df068a0f661931a9fa9d13d08407604b6a9",
  nsis: "v3.11",
  runner: "windows-2025",
  hunspell: "edb619100791110d3e34f09ec35392ad327c1135",
  hunspellWasm: "8f755ef64e8b047b77b676f9698b3dfa5cb1887d",
} as const;

export const BUN_WINDOWS_ZIP_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${PINS.bun}/bun-windows-x64.zip`;
export const TAURI_CLI_WINDOWS_ZIP_URL = `https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v${PINS.tauriCli}/cargo-tauri-x86_64-pc-windows-msvc.zip`;
