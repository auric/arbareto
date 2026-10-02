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

use std::sync::Arc;

use tauri::Manager;

use crate::service::Service;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ipc::get_environment,
            ipc::choose_git,
            ipc::choose_repository,
            ipc::restore_workspace,
            ipc::read_workspace,
            ipc::read_history,
            ipc::read_comparison,
            ipc::read_trust,
            ipc::approve_trust,
            ipc::revoke_trust,
            ipc::apply_hunk,
            ipc::apply_file,
            ipc::review_commit,
            ipc::commit,
            ipc::review_submodules,
            ipc::update_submodules,
            ipc::cancel,
            ipc::get_operation,
            ipc::request_close,
            ipc::current_session,
            ipc::dismiss_recovery_marker,
        ])
        .setup(|app| {
            // Interim (T265): start the service with fixed handshake values, then open the window. T063 sets the real startup order.
            let service = Service::start(app.handle())?;
            app.manage(Arc::clone(&service.ipc));
            app.manage(service);
            tauri::WebviewWindowBuilder::new(app, ipc::MAIN_WINDOW, tauri::WebviewUrl::default())
                .title("Arbareto")
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event
                && let Some(service) = app.try_state::<Arc<Service>>()
            {
                service.close();
            }
        });
}
