// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { BUN_WINDOWS_ZIP_URL, PINS } from "../../scripts/release/pins";
import { NSIS_VERSION, TAURI_CLI_VERSION } from "../../src/frontend/build/notices";

// T006, T024: every pin of scripts/release/pins.ts equals the value in each file that uses it (data-model §5, plan.md D2).
// Before T008 the pins import fails, so every case fails. Before T025 the workflow cases fail on the missing file.

printOrigin("../../scripts/release/pins.ts", import.meta.dir);
printOrigin("../../src/frontend/build/notices.ts", import.meta.dir);

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");

type Workflow = { env?: Record<string, unknown>; jobs?: Record<string, { "runs-on"?: unknown }> };

describe("release pins", () => {
  test("package.json packageManager and the build:service check name the pinned Bun", async () => {
    const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as { packageManager?: string; scripts?: Record<string, string> };
    expect(manifest.packageManager).toBe(`bun@${PINS.bun}`);
    const check = /^bun -e "if \(Bun\.version !== '([^']+)'\)/.exec(manifest.scripts?.["build:service"] ?? "");
    expect(check?.[1]).toBe(PINS.bun);
  });

  test("rust-toolchain.toml holds the pinned channel, profile, components, and targets", async () => {
    const toml = Bun.TOML.parse(await Bun.file(join(ROOT, "rust-toolchain.toml")).text()) as { toolchain?: Record<string, unknown> };
    expect(toml).toEqual({
      toolchain: { channel: PINS.rust, profile: "minimal", components: ["clippy", "rustfmt"], targets: ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"] },
    });
  });

  test("the notices check pins the same Tauri CLI and NSIS", () => {
    expect(TAURI_CLI_VERSION).toBe(`tauri-cli ${PINS.tauriCli}\n`);
    expect(`v${NSIS_VERSION}`).toBe(PINS.nsis);
  });

  test("the Bun Windows archive hash is the published SHA-256", () => {
    expect(PINS.bunWindowsZipSha256).toBe("cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5");
    expect(BUN_WINDOWS_ZIP_URL).toBe("https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip");
  });

  test("the release workflow names the pinned runner, Bun archive, hash, Rust, and Tauri CLI", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
    expect(workflow.jobs?.build?.["runs-on"]).toBe(PINS.runner);
    expect(workflow.env).toMatchObject({
      BUN_VERSION: PINS.bun,
      BUN_ZIP_URL: BUN_WINDOWS_ZIP_URL,
      BUN_ZIP_SHA256: PINS.bunWindowsZipSha256,
      RUST_VERSION: PINS.rust,
      TAURI_CLI_VERSION: PINS.tauriCli,
    });
  });
});

// FR-005: the preview has no updater.
describe("no updater", () => {
  test("cargo metadata lists no tauri-plugin-updater package", () => {
    const proc = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml"], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    expect(proc.exitCode).toBe(0);
    const metadata = JSON.parse(proc.stdout.toString()) as { packages: { name: string }[] };
    expect(metadata.packages.length).toBeGreaterThan(0);
    expect(metadata.packages.filter((p) => p.name === "tauri-plugin-updater")).toEqual([]);
  }, 120_000);

  // T014 creates the preview overlay and changes this list so that the overlay must exist.
  const configs = ["src-tauri/tauri.conf.json", ...(existsSync(join(ROOT, "src-tauri", "tauri.preview.conf.json")) ? ["src-tauri/tauri.preview.conf.json"] : [])];
  for (const config of configs) {
    test(`${config} has no plugins.updater and no bundle.createUpdaterArtifacts key`, async () => {
      const json = (await Bun.file(join(ROOT, config)).json()) as { plugins?: Record<string, unknown>; bundle?: Record<string, unknown> };
      expect(Object.hasOwn(json.plugins ?? {}, "updater")).toBe(false);
      expect(Object.hasOwn(json.bundle ?? {}, "createUpdaterArtifacts")).toBe(false);
    });
  }
});
