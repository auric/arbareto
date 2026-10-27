// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { BUN_WINDOWS_ZIP_URL, PINS } from "../../scripts/release/pins";
import { NSIS_VERSION, TAURI_CLI_VERSION } from "../../src/frontend/build/notices";

// T006, T014, T024: every pin of scripts/release/pins.ts equals the value in each file that uses it (data-model §5, plan.md D2).
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

  for (const config of ["src-tauri/tauri.conf.json", "src-tauri/tauri.preview.conf.json"]) {
    test(`${config} has no plugins.updater and no bundle.createUpdaterArtifacts key`, async () => {
      const json = (await Bun.file(join(ROOT, config)).json()) as { plugins?: Record<string, unknown>; bundle?: Record<string, unknown> };
      expect(Object.hasOwn(json.plugins ?? {}, "updater")).toBe(false);
      expect(Object.hasOwn(json.bundle ?? {}, "createUpdaterArtifacts")).toBe(false);
    });
  }
});

// T014: the preview overlay, its installer hook, the preview package scripts, the service file properties, and the link flag (plan.md D1, D8, D11; research R7 T002, T003).
describe("preview package", () => {
  const TARGET = "x86_64-pc-windows-msvc";
  const OVERLAY = "src-tauri/tauri.preview.conf.json";

  test("the preview overlay sets only the preview installer hook, and that hook defines no NSIS_HOOK_POSTINSTALL", async () => {
    expect(await Bun.file(join(ROOT, OVERLAY)).json()).toEqual({ bundle: { windows: { nsis: { installerHooks: "./installer-hooks.preview.nsh" } } } });
    // tauri-bundler 2.10.0 installer.nsi:702 writes DisplayName ${PRODUCTNAME}; only this macro replaces it (research R7 T003).
    expect(await Bun.file(join(ROOT, "src-tauri", "installer-hooks.preview.nsh")).text()).not.toContain("NSIS_HOOK_POSTINSTALL");
  });

  test("both preview scripts set the preview channel, name the overlay, and end with the version prints of package; the bundle step skips binary patching", async () => {
    const scripts = ((await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> }).scripts;
    const prints = scripts.package!.slice(scripts.package!.indexOf(" && ") + 4);
    expect(prints.startsWith("rustc --version")).toBe(true);
    expect(scripts["package:preview:exes"]).toBe(`ARBARETO_RELEASE_CHANNEL=preview cargo tauri build --no-bundle --target ${TARGET} --config ${OVERLAY} -- --locked && ${prints}`);
    expect(scripts["package:preview:bundle"]).toBe(`ARBARETO_RELEASE_CHANNEL=preview cargo tauri bundle --bundles nsis --no-binary-patching --target ${TARGET} --config ${OVERLAY} && ${prints}`);
  });

  test("build:service sets the Arbareto file properties, and its version equals the cargo metadata version", async () => {
    const proc = Bun.spawnSync(["cargo", "metadata", "--no-deps", "--format-version", "1", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml"], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    expect(proc.exitCode).toBe(0);
    const metadata = JSON.parse(proc.stdout.toString()) as { packages: { name: string; version: string }[] };
    const versions = metadata.packages.filter((p) => p.name === "arbareto").map((p) => p.version);
    expect(versions.length).toBe(1);
    const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> };
    // Research R7 T002: each flag and the PE VersionInfo field it sets.
    const flags = Object.fromEntries([...manifest.scripts["build:service"]!.matchAll(/ --windows-([a-z]+)=(?:"([^"]*)"|(\S+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    expect(flags).toEqual({ title: "Arbareto", publisher: "Ihor Lifanov", version: versions[0], description: "Arbareto Git service", copyright: "Copyright (c) 2026 Ihor Lifanov" });
  }, 120_000);

  test("tauri.conf.json sets the publisher and copyright of the service file properties", async () => {
    const bundle = ((await Bun.file(join(ROOT, "src-tauri", "tauri.conf.json")).json()) as { bundle: Record<string, unknown> }).bundle;
    // tauri-build 2.7.4 lib.rs:837 and tauri-bundler 2.10.0 nsis/mod.rs:268 use the second identifier segment when publisher is absent.
    expect({ publisher: bundle.publisher, copyright: bundle.copyright }).toEqual({ publisher: "Ihor Lifanov", copyright: "Copyright (c) 2026 Ihor Lifanov" });
  });

  test(".cargo/config.toml passes /Brepro to the MSVC linker", async () => {
    const config = Bun.TOML.parse(await Bun.file(join(ROOT, ".cargo", "config.toml")).text()) as { target?: Record<string, { rustflags?: unknown }> };
    expect(config.target?.[TARGET]?.rustflags).toEqual(["-C", "link-arg=/Brepro"]);
  });
});
