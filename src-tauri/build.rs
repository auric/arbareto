// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

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
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
