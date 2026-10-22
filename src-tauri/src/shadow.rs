// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 005 contract Δ6 `shadow` and the `ignorePreview` context (plan.md D9, D14).
//! The shell owns one throwaway shadow folder per preview operation below `<launch directory>/preview`.
//! It holds the two shadow repositories `s` and `c`. The folder goes when the operation ends, after Cancel, `closeJob`, or a service exit.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{CloseHandle, FILETIME};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// The subfolder of the launch directory that holds every shadow folder.
pub(crate) const PREVIEW: &str = "preview";

/// The PID and the creation time of the shell process. The sweep uses them to find leftover own folders.
pub(crate) fn self_identity() -> (u32, u64) {
    let pid = std::process::id();
    // SAFETY: the current-process pseudo handle needs no close, and `created` is a live local.
    let created = unsafe {
        let mut created = FILETIME::default();
        let (mut exit, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default());
        let _ = GetProcessTimes(
            GetCurrentProcess(),
            &raw mut created,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        );
        filetime(&created)
    };
    (pid, created)
}

fn filetime(time: &FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

/// A folder name `<pid>-<creation time>-<16 hex>` (data-model §13).
pub(crate) fn folder_name(pid: u32, created: u64) -> io::Result<String> {
    let id = crate::settings::random_id()?.replace('-', "");
    Ok(format!("{pid}-{created}-{}", &id[..16]))
}

/// The PID and creation time that a folder name encodes. `None` for any other name.
pub(crate) fn parse_name(name: &str) -> Option<(u32, u64)> {
    let mut parts = name.splitn(3, '-');
    let pid = parts.next()?.parse().ok()?;
    let created = parts.next()?.parse().ok()?;
    let hex = parts.next()?;
    (hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some((pid, created))
}

/// True when a process with `pid` is alive and has the creation time `created` (OS process facts).
pub(crate) fn alive(pid: u32, created: u64) -> bool {
    // SAFETY: `OpenProcess` returns an owned handle that `CloseHandle` closes below.
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return false;
    };
    let mut times = [FILETIME::default(); 4];
    // SAFETY: `handle` is open, and each `FILETIME` is a live local.
    let read = unsafe {
        GetProcessTimes(
            handle,
            &raw mut times[0],
            &raw mut times[1],
            &raw mut times[2],
            &raw mut times[3],
        )
    };
    let matches = read.is_ok() && filetime(&times[0]) == created;
    // SAFETY: `handle` came from `OpenProcess`.
    unsafe {
        let _ = CloseHandle(handle);
    }
    matches
}

/// Removes every leftover folder below `preview`, then creates and returns a fresh shadow folder with its `s` and `c` repositories.
/// A leftover owned by another process goes when that process is gone. An own leftover goes when `live` does not hold it.
pub(crate) fn create(launch: &Path, me: (u32, u64), live: &HashSet<PathBuf>) -> io::Result<PathBuf> {
    let preview = launch.join(PREVIEW);
    std::fs::create_dir_all(&preview)?;
    sweep(&preview, me, live);
    let folder = preview.join(folder_name(me.0, me.1)?);
    std::fs::create_dir(&folder)?;
    std::fs::create_dir(folder.join("s"))?;
    std::fs::create_dir(folder.join("c"))?;
    Ok(folder)
}

/// Removes each leftover shadow folder (plan.md D14). A folder of a gone process, or an own folder no live context holds, goes.
fn sweep(preview: &Path, me: (u32, u64), live: &HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(preview) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().and_then(|name| parse_name(name)) else {
            continue;
        };
        if leftover(name, me, live.contains(&path)) {
            remove(&path);
        }
    }
}

/// Plan.md D14: an own folder that no live context holds, or a folder whose owner process record is gone, is a leftover.
pub(crate) fn leftover(owner: (u32, u64), me: (u32, u64), held: bool) -> bool {
    if owner == me {
        !held
    } else {
        !alive(owner.0, owner.1)
    }
}

/// Removes one shadow folder. `std::fs::remove_dir_all` opens a reparse point as the link, so it never follows one.
/// shortcut: the plan names an NT no-follow walk; the std removal is symlink-safe on current Rust, and the folder is app-owned.
pub(crate) fn remove(folder: &Path) {
    let _ = std::fs::remove_dir_all(folder);
}

/// Contract Δ6: the fixed arrays that an `ignorePreview` context admits (plan.md D9, D14).
/// On Windows, the three arrays that read or write a working-tree file carry `-c core.longpaths=true` after `--no-lazy-fetch`.
pub(crate) fn fits(arguments: &[String], windows: bool) -> bool {
    let items: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let long = if windows {
        &["--no-lazy-fetch", "-c", "core.longpaths=true"][..]
    } else {
        &["--no-lazy-fetch"][..]
    };
    let with_long = |tail: &[&str]| items.len() == long.len() + tail.len()
        && items[..long.len()] == *long
        && items[long.len()..] == *tail;
    match items.as_slice() {
        ["--no-lazy-fetch", "init", "-q", "--template="] => true,
        ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"] => true,
        ["--no-lazy-fetch", "update-index", "-z", "--index-info"] => true,
        [
            "--no-lazy-fetch",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.eol=lf",
            "checkout-index",
            "-a",
            "-f",
        ] => true,
        [
            "--no-lazy-fetch",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.eol=lf",
            "checkout-index",
            "-a",
            "-f",
            "--prefix=.git/info/",
        ] => true,
        _ => {
            // `hash-object --stdin-paths`, with `-c core.longpaths=true` on Windows.
            with_long(&["hash-object", "-w", "--no-filters", "--stdin-paths"])
                || with_long(&["hash-object", "--no-filters", "--stdin-paths"])
                || with_long(&["checkout-index", "-a", "-f"])
                || with_long(&["checkout-index", "-a", "-f", "--prefix=.git/info/"])
                || check_ignore(&items, long)
        }
    }
}

/// `-c core.ignorecase=<true|false> [-c core.excludesFile=<path>] check-ignore --no-index -z --stdin -v -n`,
/// with `-c core.longpaths=true` first on Windows.
fn check_ignore(items: &[&str], long: &[&str]) -> bool {
    let Some(rest) = items.strip_prefix(long) else {
        return false;
    };
    let rest = match rest {
        ["-c", case, tail @ ..] if is_ignorecase(case) => {
            match tail {
                ["-c", excludes, tail @ ..] if excludes.starts_with("core.excludesFile=") => tail,
                tail => tail,
            }
        }
        _ => return false,
    };
    rest == ["check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"]
}

fn is_ignorecase(item: &str) -> bool {
    item == "core.ignorecase=true" || item == "core.ignorecase=false"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_name_encodes_the_pid_and_creation_time() {
        let name = folder_name(1234, 567).expect("name");
        assert_eq!(parse_name(&name), Some((1234, 567)));
        assert_eq!(parse_name("1234-567-short"), None);
        assert_eq!(parse_name("notpid-1-0123456789abcdef"), None);
    }

    #[test]
    fn create_makes_the_two_repositories_and_sweeps_leftovers() {
        let fixture = crate::jobs::tests::Fixture::new();
        let launch = fixture.path("launch");
        std::fs::create_dir_all(&launch).expect("launch");
        let me = self_identity();
        // A leftover of a process that no longer runs, and an own leftover that no context holds.
        let preview = launch.join(PREVIEW);
        std::fs::create_dir_all(&preview).expect("preview");
        let gone = preview.join(folder_name(1, 1).expect("name"));
        std::fs::create_dir_all(gone.join("s")).expect("gone");
        let own = preview.join(folder_name(me.0, me.1).expect("name"));
        std::fs::create_dir_all(&own).expect("own");
        let folder = create(&launch, me, &HashSet::new()).expect("create");
        assert!(folder.join("s").is_dir() && folder.join("c").is_dir());
        assert!(!gone.exists(), "a folder of a gone process goes");
        assert!(!own.exists(), "an own folder no context holds goes");
        assert!(folder.exists(), "the new folder stays");
    }

    #[test]
    fn create_keeps_a_live_own_folder() {
        let fixture = crate::jobs::tests::Fixture::new();
        let launch = fixture.path("launch");
        std::fs::create_dir_all(&launch).expect("launch");
        let me = self_identity();
        let folder = create(&launch, me, &HashSet::new()).expect("first");
        let mut live = HashSet::new();
        live.insert(folder.clone());
        let second = create(&launch, me, &live).expect("second");
        assert!(folder.exists(), "a held own folder stays");
        assert!(second.exists());
    }

    /// Contract Δ6: the accepted arrays, with `-c core.longpaths=true` on Windows for the working-tree arrays.
    #[test]
    fn fits_admits_only_the_contract_arrays() {
        let a = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(fits(&a(&["--no-lazy-fetch", "init", "-q", "--template="]), true));
        assert!(fits(
            &a(&["--no-lazy-fetch", "update-index", "-z", "--index-info"]),
            true
        ));
        assert!(fits(
            &a(&["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"]),
            true
        ));
        // `--stdin-paths` reads working-tree files, so Windows adds `-c core.longpaths=true`.
        assert!(fits(
            &a(&[
                "--no-lazy-fetch",
                "-c",
                "core.longpaths=true",
                "hash-object",
                "-w",
                "--no-filters",
                "--stdin-paths"
            ]),
            true
        ));
        assert!(!fits(
            &a(&["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin-paths"]),
            true
        ), "a Windows `--stdin-paths` without core.longpaths is refused");
        assert!(fits(
            &a(&["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin-paths"]),
            false
        ), "WSL needs no core.longpaths");
        assert!(fits(
            &a(&[
                "--no-lazy-fetch",
                "-c",
                "core.longpaths=true",
                "-c",
                "core.ignorecase=true",
                "-c",
                "core.excludesFile=C:\\x",
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
                "-v",
                "-n"
            ]),
            true
        ));
        assert!(fits(
            &a(&[
                "--no-lazy-fetch",
                "-c",
                "core.ignorecase=false",
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
                "-v",
                "-n"
            ]),
            false
        ));
        for bad in [
            &["--no-lazy-fetch", "status"][..],
            &["--no-lazy-fetch", "init"][..],
            &["--no-lazy-fetch", "-c", "core.ignorecase=maybe", "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"][..],
            &["--no-lazy-fetch", "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"][..],
        ] {
            assert!(!fits(&a(bad), false), "{bad:?}");
        }
    }
}
