// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "T058 implements the WebView2 checks, and T063 runs them"
    )
)]
#![cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the T058 stubs read no input until T058 implements them"
    )
)]

/// The provisional WebView2 minimum: the reference host version (plan.md "Provisional prerequisite admission").
pub const MINIMUM: &str = "154.0.4258.37";

/// Compares the four numeric parts of `version` with `MINIMUM`.
/// `None` is a missing runtime and gives `WEBVIEW_UNAVAILABLE`. A lower or unparseable version gives `WEBVIEW_UNSUPPORTED`.
pub fn admission(_version: Option<&str>) -> Result<(), &'static str> {
    todo!("T058")
}

/// One `AcceleratorKeyPressed` event: the `VirtualKey` and the modifier state.
#[derive(Clone, Copy, Debug)]
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
    todo!("T058")
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
pub fn page_menu(_kind: TargetKind, _editable: bool, _selection: bool, _items: &[&str]) -> Menu {
    todo!("T058")
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
