// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 004 contract Δ3 `revealPath`: the private `reveal` request shows one path in Explorer.

use std::path::Path;

use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{ILFree, SHOpenFolderAndSelectItems, SHParseDisplayName};
use windows::core::HSTRING;

/// Opens the folder of `path` in Explorer and selects the item (Microsoft Learn `SHOpenFolderAndSelectItems`).
/// False when COM, the parse, or the open fails.
pub(crate) fn show(path: &Path) -> bool {
    // SAFETY: a successful call is paired with `CoUninitialize` on this thread below.
    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
        return false;
    }
    let name = HSTRING::from(path.as_os_str());
    let mut item: *mut ITEMIDLIST = std::ptr::null_mut();
    // SAFETY: `name` and `item` are live locals. A zero item count selects the item that `item` names in its folder.
    let shown = unsafe { SHParseDisplayName(&name, None, &raw mut item, 0, None) }.is_ok()
        && unsafe { SHOpenFolderAndSelectItems(item, None, 0) }.is_ok();
    // SAFETY: `item` is null or the list that `SHParseDisplayName` allocated. Nothing else holds it.
    unsafe {
        ILFree(Some(item.cast_const()));
        CoUninitialize();
    }
    shown
}
