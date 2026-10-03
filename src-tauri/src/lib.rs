// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

mod bootstrap;
mod dialogs;
mod env_sanitize;
mod framing;
mod git_env;
mod ipc;
mod jobs;
mod platform;
mod process_requests;
mod service;
mod settings;
mod spawn;
mod webview;

use std::sync::{Arc, Mutex};

use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::dialogs::{Dialogs, Native};
use crate::ipc::{Ipc, MAIN_WINDOW};
use crate::service::{Facts, Service, Stores};
use crate::settings::{Bounds, Markers, Trust};

/// The native settings file in the application config directory (data-model §1).
const SETTINGS_FILE: &str = "settings.json";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        .setup(|app| start(app))
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

/// The cold-start order of plan.md "Cold-start critical path".
fn start(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let service = Service::start(app.handle()).ok();
    let facts = platform::read();
    let Ok(webview2_version) = webview::check() else {
        // `check` showed the message. No window opens.
        if let Some(service) = &service {
            service.close();
        }
        app.handle().exit(1);
        return Ok(());
    };
    let config = app.path().app_config_dir()?;
    let data = app.path().app_data_dir()?;
    // Without the folder, `settings::load` gives the defaults, and a later save fails.
    let _ = std::fs::create_dir_all(&config);
    let settings_path = config.join(SETTINGS_FILE);
    let settings = settings::load(&settings_path);
    let stored_bounds = settings.window;

    let connected = match &service {
        Some(service) => service.connect(
            &Facts {
                platform_scope: platform::scope(facts).as_str(),
                os_build: facts.build,
                webview2_version,
            },
            Stores {
                settings_path,
                settings: Mutex::new(settings),
                markers: Markers::open(&data.join("recovery")),
                trust: Trust::open(&data.join("trust")),
            },
        ),
        None => false,
    };
    match service {
        Some(service) => {
            app.manage(Arc::clone(&service.ipc));
            app.manage(service);
        }
        // `currentSession` then gives SERVICE_UNAVAILABLE (contract §2).
        None => {
            app.manage(Arc::new(Ipc::new(Arc::new(|_| false))));
        }
    }

    let window = main_window(app, stored_bounds)?;
    let shown = window.clone();
    let handle = app.handle().clone();
    window.with_webview(move |webview| {
        if let Err(error) = webview::attach(&webview.controller()) {
            eprintln!("WebView2 handlers: {error}");
        }
        let _ = shown.show();
        if !connected {
            // T142 routes this case through `lifecycle.rs` and adds Restart service.
            std::thread::spawn(move || {
                Dialogs::new(handle.clone()).confirm(&dialogs::service_stopped());
                handle.exit(0);
            });
        }
    })?;
    Ok(())
}

/// The hidden main window with clamped bounds (plan.md "Chosen layout, sizes, and DPI"). The capability grants only this label.
fn main_window(app: &App, stored: Option<Bounds>) -> tauri::Result<WebviewWindow> {
    let (minimum_width, minimum_height) = settings::MINIMUM_SIZE;
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::default())
        .title("Arbareto")
        .visible(false)
        .zoom_hotkeys_enabled(false)
        .min_inner_size(minimum_width.into(), minimum_height.into());
    // ponytail: the primary monitor only; a per-monitor lookup follows when a task stores window bounds.
    if let Some(bounds) = work_area(app).and_then(|area| settings::clamp(stored, area).ok()) {
        builder = builder
            .position(bounds.x.into(), bounds.y.into())
            .inner_size(bounds.width.into(), bounds.height.into());
    }
    builder.build()
}

/// The work area of the primary monitor in DIPs.
fn work_area(app: &App) -> Option<Bounds> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let dips = |pixels: f64| (pixels / scale) as i32;
    Some(Bounds {
        x: dips(area.position.x.into()),
        y: dips(area.position.y.into()),
        width: dips(area.size.width.into()),
        height: dips(area.size.height.into()),
    })
}
