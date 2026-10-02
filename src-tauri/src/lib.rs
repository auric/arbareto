// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

mod bootstrap;
mod env_sanitize;
mod framing;
mod git_env;
mod ipc;
mod jobs;
mod process_requests;
mod service;
mod spawn;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Arbareto")
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Tauri application");
}
