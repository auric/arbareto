// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::path::Path;
use std::process::Command;

// Tauri invokes a command by its Rust function name, so the names are snake_case.
const COMMANDS: &[&str] = &[
    "get_environment",
    "choose_git",
    "choose_repository",
    "restore_workspace",
    "read_workspace",
    "read_history",
    "read_comparison",
    "read_trust",
    "approve_trust",
    "revoke_trust",
    "apply_hunk",
    "apply_file",
    "review_commit",
    "commit",
    "review_submodules",
    "update_submodules",
    "cancel",
    "get_operation",
    "request_close",
    "current_session",
    "dismiss_recovery_marker",
];

fn main() {
    println!(
        "cargo:rustc-env=ARBARETO_BUILD_IDENTITY={}",
        build_identity()
    );
    // Cargo treats a missing `rerun-if-changed` path as stale, so the script runs in every build (T063).
    let out_dir = std::env::var("OUT_DIR").expect("Cargo sets OUT_DIR for build scripts");
    println!(
        "cargo:rerun-if-changed={}",
        Path::new(&out_dir)
            .join("arbareto-build-identity.always-rerun")
            .display()
    );
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}

/// The full commit ID of `HEAD`, with `-dirty` when Git lists any change or untracked file (plan.md "About window").
fn build_identity() -> String {
    let commit = git("rev-parse HEAD");
    let commit = commit.trim_end();
    // The service accepts a SHA-1 or a SHA-256 commit ID (contract §6 "Startup handshake").
    assert!(
        matches!(commit.len(), 40 | 64)
            && commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "git rev-parse HEAD printed no full commit ID"
    );
    let status = git("--no-optional-locks status --porcelain --untracked-files=all");
    if status.is_empty() {
        commit.to_string()
    } else {
        format!("{commit}-dirty")
    }
}

/// A build without its commit ID would embed a false identity, so a failed Git call fails the build.
/// `arguments` holds no quoted argument, so a split on spaces gives the argument array.
fn git(arguments: &str) -> String {
    let output = Command::new("git")
        .args(arguments.split(' '))
        .output()
        .expect("run Git for the build identity");
    assert!(output.status.success(), "git {arguments} failed");
    String::from_utf8(output.stdout).expect("UTF-8 Git output")
}
