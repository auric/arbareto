// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "T058 implements the WebView2 checks, and T063 runs them"
    )
)]
use std::sync::atomic::{AtomicBool, Ordering};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND, COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_AUDIO,
    COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
    COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_SELECTED_TEXT,
    COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO, GetAvailableCoreWebView2BrowserVersionString,
    ICoreWebView2, ICoreWebView2_11, ICoreWebView2AcceleratorKeyPressedEventArgs,
    ICoreWebView2AcceleratorKeyPressedEventArgs2, ICoreWebView2ContextMenuRequestedEventArgs,
    ICoreWebView2Controller, ICoreWebView2Settings3,
};
use webview2_com::{
    AcceleratorKeyPressedEventHandler, ContextMenuRequestedEventHandler, take_pwstr,
};
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
use windows::core::{BOOL, HSTRING, Interface, PCWSTR, PWSTR};

/// The provisional WebView2 minimum: the reference host version (plan.md "Provisional prerequisite admission").
pub const MINIMUM: &str = "154.0.4258.37";

/// The handshake carries at most 64 ASCII bytes of version text (contract §5).
const VERSION_BYTES: usize = 64;

/// Compares the four numeric parts of `version` with `MINIMUM`.
/// `None` is a missing runtime and gives `WEBVIEW_UNAVAILABLE`. A lower or unparseable version gives `WEBVIEW_UNSUPPORTED`.
pub fn admission(version: Option<&str>) -> Result<(), &'static str> {
    let version = version.ok_or("WEBVIEW_UNAVAILABLE")?;
    match (parts(version), parts(MINIMUM)) {
        (Some(found), Some(minimum)) if found >= minimum => Ok(()),
        _ => Err("WEBVIEW_UNSUPPORTED"),
    }
}

/// Four dot-separated parts of decimal digits. `u32::from_str` also accepts a sign, so each byte is checked first.
fn parts(version: &str) -> Option<[u32; 4]> {
    if version.len() > VERSION_BYTES {
        return None;
    }
    let mut split = version.split('.');
    let mut parts = [0; 4];
    for part in &mut parts {
        let digits = split
            .next()
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))?;
        *part = digits.parse().ok()?;
    }
    split.next().is_none().then_some(parts)
}

/// The installed runtime version, read before any webview exists. `None` is a missing runtime.
pub fn installed_version() -> Option<String> {
    let mut version = PWSTR::null();
    // SAFETY: `version` is a live local. On success it holds a CoTaskMem string or null, and `take_pwstr` frees it.
    unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }.ok()?;
    (!version.is_null()).then(|| take_pwstr(version))
}

/// Admits the installed runtime and returns its version text for the handshake.
/// On rejection, shows a native message and returns the error code. The caller then creates no window.
#[cfg_attr(test, expect(dead_code, reason = "T063 calls it at startup"))]
pub fn check() -> Result<String, &'static str> {
    let version = installed_version();
    if let Err(code) = admission(version.as_deref()) {
        let text = format!(
            "Arbareto cannot start. It needs the WebView2 Runtime {MINIMUM} or later.\nDetected version: {}.\nError code: {code}.",
            version.as_deref().unwrap_or("none")
        );
        // SAFETY: both strings are live for the call, and the message has no owner window.
        unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(text),
                &HSTRING::from("Arbareto"),
                MB_OK | MB_ICONERROR,
            )
        };
        return Err(code);
    }
    Ok(version.unwrap_or_default())
}

/// One `AcceleratorKeyPressed` event: the `VirtualKey` and the modifier state.
#[derive(Clone, Copy, Debug)]
#[expect(
    dead_code,
    reason = "the decision is the same for every key (research.md R7)"
)]
pub struct Key {
    pub virtual_key: u32,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// The values that the handler sets on the event arguments (research.md R7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accelerator {
    /// `IsBrowserAcceleratorKeyEnabled` on `ICoreWebView2AcceleratorKeyPressedEventArgs2`.
    pub browser_action_enabled: bool,
    /// `Handled`. It stays false, so every key reaches the page.
    pub handled: bool,
}

/// The accelerator decision. It has no fallback path (research.md R7).
pub fn accelerator(_key: Key) -> Accelerator {
    Accelerator {
        browser_action_enabled: false,
        handled: false,
    }
}

/// `COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Page,
    Image,
    SelectedText,
    Audio,
    Video,
}

/// The page-menu decision for one `ContextMenuRequested` event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Menu {
    /// Keep these item names, in their given order, and remove every other item.
    Keep(Vec<String>),
    /// Set `Handled` to true and show no menu.
    NoMenu,
}

/// Filters the default menu by the target kind, `IsEditable`, `HasSelection`, and the item `Name` values.
/// An editable target keeps the editing items. A selected-text target keeps `copy` and `selectAll`. Any other target shows no menu.
pub fn page_menu(kind: TargetKind, editable: bool, selection: bool, items: &[&str]) -> Menu {
    let allowed: &[&str] = if editable {
        &["cut", "copy", "paste", "selectAll"]
    } else if kind == TargetKind::SelectedText || selection {
        &["copy", "selectAll"]
    } else {
        &[]
    };
    let kept: Vec<String> = items
        .iter()
        .filter(|item| allowed.contains(item))
        .map(|item| item.to_string())
        .collect();
    if kept.is_empty() {
        Menu::NoMenu
    } else {
        Menu::Keep(kept)
    }
}

/// Logs the first failed `ICoreWebView2AcceleratorKeyPressedEventArgs2` cast only.
static ARGS2_CAST_FAILED: AtomicBool = AtomicBool::new(false);

/// Runs inside the one `with_webview` call on the hidden main window, before the window shows (research.md R7).
/// Keeps `AreDefaultContextMenusEnabled` true, because `ContextMenuRequested` fires only then.
#[cfg_attr(test, expect(dead_code, reason = "T063 calls it in `with_webview`"))]
pub fn attach(controller: &ICoreWebView2Controller) -> windows::core::Result<()> {
    let mut token = 0;
    // SAFETY: `with_webview` runs on the UI thread of the webview, and `controller` is live.
    unsafe {
        controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(on_accelerator_key)),
            &mut token,
        )?;
        let webview = controller.CoreWebView2()?;
        webview
            .cast::<ICoreWebView2_11>()?
            .add_ContextMenuRequested(
                &ContextMenuRequestedEventHandler::create(Box::new(on_context_menu)),
                &mut token,
            )?;
        webview
            .Settings()?
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)
    }
}

fn on_accelerator_key(
    _: Option<ICoreWebView2Controller>,
    args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>,
) -> windows::core::Result<()> {
    let Some(args) = args else {
        return Ok(());
    };
    let mut virtual_key = 0;
    // SAFETY: WebView2 calls the handler on the UI thread with live arguments.
    unsafe { args.VirtualKey(&mut virtual_key) }?;
    // The decision reads no key field (research.md R7), so the handler reads no modifier state.
    let decision = accelerator(Key {
        virtual_key,
        ctrl: false,
        shift: false,
        alt: false,
    });
    let Ok(args) = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() else {
        // Every admitted runtime provides the interface, so a failure is an admission defect (research.md R7).
        if !ARGS2_CAST_FAILED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "WebView2 AcceleratorKeyPressed: ICoreWebView2AcceleratorKeyPressedEventArgs2 is missing"
            );
        }
        return Ok(());
    };
    // SAFETY: as above. `Handled` stays false, so every key reaches the page.
    unsafe { args.SetIsBrowserAcceleratorKeyEnabled(decision.browser_action_enabled) }
}

fn on_context_menu(
    _: Option<ICoreWebView2>,
    args: Option<ICoreWebView2ContextMenuRequestedEventArgs>,
) -> windows::core::Result<()> {
    let Some(args) = args else {
        return Ok(());
    };
    if filter_menu(&args).is_err() {
        // SAFETY: WebView2 calls the handler on the UI thread with live arguments.
        unsafe { args.SetHandled(true) }?;
    }
    Ok(())
}

fn filter_menu(args: &ICoreWebView2ContextMenuRequestedEventArgs) -> windows::core::Result<()> {
    // SAFETY: WebView2 calls the handler on the UI thread with live arguments. `take_pwstr` frees each name.
    unsafe {
        let target = args.ContextMenuTarget()?;
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND::default();
        target.Kind(&mut kind)?;
        let mut editable = BOOL::default();
        target.IsEditable(&mut editable)?;
        let mut selection = BOOL::default();
        target.HasSelection(&mut selection)?;
        let items = args.MenuItems()?;
        let mut count = 0;
        items.Count(&mut count)?;
        let mut names = Vec::with_capacity(count as usize);
        for index in 0..count {
            let mut name = PWSTR::null();
            items.GetValueAtIndex(index)?.Name(&mut name)?;
            names.push(take_pwstr(name));
        }
        let kind = match kind {
            COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE => TargetKind::Image,
            COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_SELECTED_TEXT => TargetKind::SelectedText,
            COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_AUDIO => TargetKind::Audio,
            COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO => TargetKind::Video,
            // `COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_PAGE`, and any kind that a later runtime adds, get the page rule.
            _ => TargetKind::Page,
        };
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        match page_menu(kind, editable.as_bool(), selection.as_bool(), &refs) {
            Menu::NoMenu => args.SetHandled(true),
            Menu::Keep(kept) => {
                for index in (0..count).rev() {
                    if !kept.contains(&names[index as usize]) {
                        items.RemoveValueAtIndex(index)?;
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Virtual-key codes from Microsoft Learn "Virtual-Key Codes" (winuser.h).
    const VK_LEFT: u32 = 0x25;
    const VK_ESCAPE: u32 = 0x1b;
    const VK_F3: u32 = 0x72;
    const VK_F5: u32 = 0x74;
    const VK_F7: u32 = 0x76;
    const VK_F12: u32 = 0x7b;
    const VK_ADD: u32 = 0x6b;
    const VK_OEM_PLUS: u32 = 0xbb;

    fn key(virtual_key: u32, modifiers: &str) -> Key {
        Key {
            virtual_key,
            ctrl: modifiers.contains("ctrl"),
            shift: modifiers.contains("shift"),
            alt: modifiers.contains("alt"),
        }
    }

    fn letter(c: char) -> u32 {
        c as u32
    }

    #[test]
    fn the_minimum_and_newer_versions_are_admitted() {
        assert_eq!(MINIMUM, "154.0.4258.37");
        for version in [
            "154.0.4258.37",
            "154.0.4258.38",
            "154.0.4259.0",
            "155.0.4258.37",
        ] {
            assert_eq!(admission(Some(version)), Ok(()), "{version}");
        }
    }

    #[test]
    fn lower_versions_are_unsupported() {
        for version in ["154.0.4258.36", "154.0.4257.99", "153.0.4234.48"] {
            assert_eq!(
                admission(Some(version)),
                Err("WEBVIEW_UNSUPPORTED"),
                "{version}"
            );
        }
    }

    #[test]
    fn the_parts_compare_numerically_not_as_text() {
        // As text, "1000.0.0.0" sorts before "154.0.4258.37".
        assert_eq!(admission(Some("1000.0.0.0")), Ok(()));
        assert_eq!(admission(Some("154.0.999.0")), Err("WEBVIEW_UNSUPPORTED"));
    }

    #[test]
    fn unparseable_text_is_unsupported() {
        for version in [
            "",
            "154.0.4258",
            "154.0.4258.37.1",
            "154.0..37",
            "v154.0.4258.37",
            "154.+0.4258.37",
            "154.0.4258.x",
        ] {
            assert_eq!(
                admission(Some(version)),
                Err("WEBVIEW_UNSUPPORTED"),
                "{version:?}"
            );
        }
    }

    #[test]
    fn a_missing_runtime_is_unavailable() {
        assert_eq!(admission(None), Err("WEBVIEW_UNAVAILABLE"));
    }

    #[test]
    fn every_key_disables_the_browser_action_and_reaches_the_page() {
        let keys = [
            ("F5", key(VK_F5, "")),
            ("Escape", key(VK_ESCAPE, "")),
            ("Ctrl+R", key(letter('R'), "ctrl")),
            ("Shift+F5", key(VK_F5, "shift")),
            ("Ctrl+F", key(letter('F'), "ctrl")),
            ("F3", key(VK_F3, "")),
            ("Ctrl+P", key(letter('P'), "ctrl")),
            ("Ctrl+plus", key(VK_OEM_PLUS, "ctrl")),
            ("Ctrl+numpad plus", key(VK_ADD, "ctrl")),
            ("Alt+Left", key(VK_LEFT, "alt")),
            ("F7", key(VK_F7, "")),
            ("Ctrl+J", key(letter('J'), "ctrl")),
            ("F12", key(VK_F12, "")),
            ("Ctrl+C", key(letter('C'), "ctrl")),
            ("Ctrl+V", key(letter('V'), "ctrl")),
            ("Ctrl+Z", key(letter('Z'), "ctrl")),
        ];
        for (name, key) in keys {
            assert_eq!(
                accelerator(key),
                Accelerator {
                    browser_action_enabled: false,
                    handled: false
                },
                "{name}"
            );
        }
    }

    /// Host test: the loader reads and frees the version text of the installed runtime.
    #[test]
    fn the_host_runtime_reports_a_parseable_version() {
        let version = installed_version().expect("an installed WebView2 Runtime");
        assert!(parts(&version).is_some(), "{version:?}");
    }

    const ALL_ITEMS: [&str; 10] = [
        "back",
        "forward",
        "reload",
        "saveAs",
        "print",
        "cut",
        "copy",
        "paste",
        "selectAll",
        "inspect",
    ];

    fn keep(items: &[&str]) -> Menu {
        Menu::Keep(items.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn an_editable_target_keeps_only_cut_copy_paste_and_select_all() {
        assert_eq!(
            page_menu(TargetKind::Page, true, false, &ALL_ITEMS),
            keep(&["cut", "copy", "paste", "selectAll"])
        );
        assert_eq!(
            page_menu(TargetKind::Page, true, true, &ALL_ITEMS),
            keep(&["cut", "copy", "paste", "selectAll"]),
            "an editable target with a selection"
        );
    }

    #[test]
    fn a_selected_text_target_keeps_only_copy_and_select_all() {
        assert_eq!(
            page_menu(TargetKind::SelectedText, false, true, &ALL_ITEMS),
            keep(&["copy", "selectAll"])
        );
    }

    #[test]
    fn any_other_target_shows_no_menu() {
        for kind in [
            TargetKind::Page,
            TargetKind::Image,
            TargetKind::Audio,
            TargetKind::Video,
        ] {
            assert_eq!(
                page_menu(kind, false, false, &ALL_ITEMS),
                Menu::NoMenu,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn a_result_with_no_item_shows_no_menu() {
        let navigation = ["back", "forward", "reload", "saveAs", "print", "inspect"];
        assert_eq!(
            page_menu(TargetKind::Page, true, false, &navigation),
            Menu::NoMenu
        );
        assert_eq!(
            page_menu(TargetKind::SelectedText, false, true, &["cut", "paste"]),
            Menu::NoMenu
        );
        assert_eq!(page_menu(TargetKind::Page, true, false, &[]), Menu::NoMenu);
    }

    #[test]
    fn navigation_save_print_and_inspect_items_never_survive() {
        let never = ["reload", "back", "forward", "saveAs", "print", "inspect"];
        for kind in [
            TargetKind::Page,
            TargetKind::Image,
            TargetKind::SelectedText,
            TargetKind::Audio,
            TargetKind::Video,
        ] {
            for editable in [false, true] {
                for selection in [false, true] {
                    if let Menu::Keep(kept) = page_menu(kind, editable, selection, &ALL_ITEMS) {
                        assert!(
                            kept.iter().all(|item| !never.contains(&item.as_str())),
                            "{kind:?} editable {editable} selection {selection}: {kept:?}"
                        );
                    }
                }
            }
        }
    }
}
