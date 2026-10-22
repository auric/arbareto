// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#[cfg(windows)]
mod bootstrap;
#[cfg(windows)]
mod close;
#[cfg(windows)]
mod dialogs;
#[cfg_attr(not(windows), allow(dead_code))]
mod env_sanitize;
#[cfg(windows)]
mod file_append;
#[cfg(windows)]
mod file_delete;
#[cfg(windows)]
mod file_facts;
#[cfg(windows)]
mod file_replace;
#[cfg_attr(not(windows), allow(dead_code))]
mod framing;
#[cfg_attr(not(windows), allow(dead_code))]
mod git_env;
#[cfg(windows)]
mod ipc;
#[cfg(windows)]
mod jobs;
#[cfg(windows)]
mod lifecycle;
#[cfg(windows)]
mod platform;
#[cfg(windows)]
mod process_requests;
#[cfg_attr(not(windows), allow(dead_code))]
mod profile;
#[cfg(windows)]
mod putty;
#[cfg(windows)]
mod reveal;
#[cfg(windows)]
mod schema;
#[cfg(windows)]
mod service;
#[cfg(windows)]
mod settings;
#[cfg(windows)]
mod shadow;
#[cfg(windows)]
mod spawn;
#[cfg(windows)]
mod text_scale;
#[cfg(windows)]
mod webview;
#[cfg(windows)]
mod wsl;

#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(windows)]
use crate::dialogs::{Dialogs, Native};
#[cfg(windows)]
use crate::ipc::{Ipc, MAIN_WINDOW, NativeFirst};
#[cfg(windows)]
use crate::profile::Folders;
#[cfg(windows)]
use crate::service::{Facts, Service, Stores};
#[cfg(windows)]
use crate::settings::{Bounds, Markers, Trust};

/// The native settings file in the application config directory (data-model §1).
#[cfg(windows)]
const SETTINGS_FILE: &str = "settings.json";

#[cfg(not(windows))]
pub fn run() {
    eprintln!(
        "Arbareto supports only Windows. This build cannot run on {}.",
        std::env::consts::OS
    );
    std::process::exit(1);
}

#[cfg(windows)]
pub fn run() {
    // The check runs before Tauri starts, so a refusal writes no file.
    let root = profile::root(std::env::var_os(profile::VARIABLE))
        .unwrap_or_else(|refusal| profile::refuse(&refusal));
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ipc::get_environment,
            ipc::choose_git,
            ipc::choose_repository,
            ipc::restore_workspace,
            ipc::list_recent_repositories,
            ipc::open_recent_repository,
            ipc::remove_recent_repository,
            ipc::read_workspace,
            ipc::read_entries,
            ipc::open_history,
            ipc::load_history,
            ipc::read_history_rows,
            ipc::search_history,
            ipc::close_history,
            ipc::read_refs,
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
            ipc::read_tracking,
            ipc::review_sync,
            ipc::sync,
            ipc::clone,
            ipc::connect_in_terminal,
            ipc::read_sync_settings,
            ipc::set_ssh_client,
            ipc::set_default_pull_action,
            ipc::choose_sync_path,
            ipc::clear_sync_path,
            ipc::launch_puttygen,
            ipc::read_branches,
            ipc::read_worktrees,
            ipc::read_git_settings,
            ipc::review_workbench,
            ipc::run_workbench,
            ipc::apply_files,
            ipc::open_worktree,
            ipc::reveal_path,
            ipc::set_switch_choice,
            ipc::choose_worktree_folder,
            ipc::read_commit_changes,
            ipc::read_commit_file,
            ipc::read_blame,
            ipc::read_ignore_file,
            ipc::preview_ignore,
            ipc::open_submodule,
        ])
        .setup(move |app| start(app, root.as_deref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == MAIN_WINDOW
                && let Some(service) = window.try_state::<Arc<Service>>()
            {
                api.prevent_close();
                let service = Arc::clone(&service);
                // The close prompt blocks, so it never runs on the main thread.
                std::thread::spawn(move || service.request_close(close::Request::Window));
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event
                && let Some(service) = app.try_state::<Arc<Service>>()
            {
                service.close();
                if service.relaunch() {
                    app.cleanup_before_exit();
                    tauri::process::restart(&app.env());
                }
            }
        });
}

/// The cold-start order of plan.md "Cold-start critical path".
#[cfg(windows)]
fn start(app: &mut App, root: Option<&Path>) -> Result<(), Box<dyn std::error::Error>> {
    let folders = match root {
        Some(root) => Folders::under(root),
        None => Folders {
            config: app.path().app_config_dir()?,
            data: app.path().app_data_dir()?,
            launch: None,
            webview: None,
        },
    };
    let service = Service::start(app.handle(), folders.launch).ok();
    let facts = platform::read();
    let Ok(webview2_version) = webview::check() else {
        // `check` showed the message. No window opens.
        if let Some(service) = &service {
            service.close();
        }
        app.handle().exit(1);
        return Ok(());
    };
    let Folders {
        config,
        data,
        webview,
        ..
    } = folders;
    // Without the folder, `settings::load` gives the defaults, and a later save fails.
    let _ = std::fs::create_dir_all(&config);
    let settings_path = config.join(SETTINGS_FILE);
    let settings = settings::load(&settings_path);
    let stored_bounds = settings.window;

    let connected = match &service {
        Some(service) => service.connect(
            Facts {
                platform_scope: platform::scope(facts).as_str(),
                os_build: facts.build,
                webview2_version,
            },
            Stores {
                settings_path,
                settings: Mutex::new(settings),
                markers: Arc::new(Markers::open(&data.join("recovery"))),
                trust: Arc::new(Trust::open(&data.join("trust"))),
                current: Mutex::new(None),
            },
        ),
        None => Err(lifecycle::Event::StartFailed),
    };
    match &service {
        Some(service) => {
            app.manage(Arc::clone(&service.ipc));
            app.manage(Arc::clone(service));
        }
        // `currentSession` then gives SERVICE_UNAVAILABLE (contract §2).
        None => {
            app.manage(Arc::new(Ipc::new(Arc::new(|_| false))));
        }
    }
    let ipc = Arc::clone(&app.state::<Arc<Ipc>>());
    app.manage(text_scale::watch(ipc, app.handle().clone()));

    let window = main_window(app, stored_bounds, webview)?;
    // Feature 005 plan.md D7: the Recycle Bin operation parents its warning dialog to the main window.
    if let (Some(service), Ok(hwnd)) = (&service, window.hwnd()) {
        service.bind_owner_window(hwnd.0 as isize);
    }
    let shown = window.clone();
    let handle = app.handle().clone();
    window.with_webview(move |webview| {
        let failed = handle.clone();
        let on_process_failed = move |kind| {
            if let Some(service) = failed.try_state::<Arc<Service>>() {
                lifecycle::handle(&*service, lifecycle::Event::ProcessFailed(kind));
            }
        };
        if let Err(error) = webview::attach(&webview.controller(), on_process_failed) {
            eprintln!("WebView2 handlers: {error}");
        }
        let _ = shown.show();
        match (connected, service) {
            (Ok(()), _) => {}
            (Err(event), Some(service)) => lifecycle::handle(&service, event),
            // Without a `Service`, no restart can run.
            (Err(_), None) => {
                std::thread::spawn(move || {
                    Dialogs::new(handle.clone()).confirm(&dialogs::service_stopped());
                    service::quit(&handle);
                });
            }
        }
    })?;
    Ok(())
}

/// The hidden main window with clamped bounds (plan.md "Chosen layout, sizes, and DPI"). The capability grants only this label.
#[cfg(windows)]
fn main_window(
    app: &App,
    stored: Option<Bounds>,
    webview: Option<PathBuf>,
) -> tauri::Result<WebviewWindow> {
    let (minimum_width, minimum_height) = settings::MINIMUM_SIZE;
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::default())
        .title(service::window_title(None))
        .visible(false)
        .zoom_hotkeys_enabled(false)
        .min_inner_size(minimum_width.into(), minimum_height.into());
    // ponytail: the primary monitor only; a per-monitor lookup follows when a task stores window bounds.
    if let Some(bounds) = work_area(app).and_then(|area| settings::clamp(stored, area).ok()) {
        builder = builder
            .position(bounds.x.into(), bounds.y.into())
            .inner_size(bounds.width.into(), bounds.height.into());
    }
    if let Some(webview) = webview {
        builder = builder.data_directory(webview);
    }
    builder.build()
}

/// The work area of the primary monitor in DIPs.
#[cfg(windows)]
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
