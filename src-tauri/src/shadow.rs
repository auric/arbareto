// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 005 contract Δ6 `shadow` and the `ignorePreview` context (plan.md D9, D14).
//! The shell owns one throwaway shadow folder per preview operation below `<launch directory>/preview`.
//! It holds the two shadow repositories `s` and `c`. The folder goes when the operation ends, after Cancel, `closeJob`, or a service exit.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, FILETIME};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// The subfolder of the launch directory that holds every shadow folder.
pub(crate) const PREVIEW: &str = "preview";
/// The empty configuration file of a Windows shadow folder. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` name it (contract Δ6, F15).
pub(crate) const EMPTY_CONFIG: &str = "empty.gitconfig";

/// The PID and the creation time of the shell process. The sweep uses them to find leftover own folders.
pub(crate) fn self_identity() -> (u32, u64) {
    let pid = std::process::id();
    // SAFETY: the current-process pseudo handle needs no close, and `created` is a live local.
    let created = unsafe {
        let mut created = FILETIME::default();
        let (mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
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

/// The creation time of process `pid`. `Err` holds the `OpenProcess` error. `Ok(None)` is a failed `GetProcessTimes`.
fn process_created(pid: u32) -> Result<Option<u64>, windows::core::HRESULT> {
    // SAFETY: `OpenProcess` returns an owned handle that `CloseHandle` closes below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|error| error.code())?;
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
    // SAFETY: `handle` came from `OpenProcess`.
    unsafe {
        let _ = CloseHandle(handle);
    }
    Ok(read.ok().map(|()| filetime(&times[0])))
}

/// Plan.md D14: only `ERROR_INVALID_PARAMETER` from `OpenProcess` means that no process has the PID.
/// Another failure keeps the folder. A process with the PID and another creation time is another process.
fn gone_by(fact: Result<Option<u64>, windows::core::HRESULT>, created: u64) -> bool {
    match fact {
        Err(code) => code == ERROR_INVALID_PARAMETER.to_hresult(),
        Ok(None) => false,
        Ok(Some(time)) => time != created,
    }
}

/// True when no process with `pid` and the creation time `created` exists (OS process facts).
pub(crate) fn gone(pid: u32, created: u64) -> bool {
    gone_by(process_created(pid), created)
}

/// Creates a fresh shadow folder with its `s` and `c` repositories, and returns it with the leftover folders below `preview`.
/// The caller removes the leftovers after it releases the state lock. A leftover is never the new folder or a live one.
pub(crate) fn create(
    launch: &Path,
    me: (u32, u64),
    live: &HashSet<PathBuf>,
) -> io::Result<(PathBuf, Vec<PathBuf>)> {
    let preview = launch.join(PREVIEW);
    std::fs::create_dir_all(&preview)?;
    let leftovers = leftovers(&preview, me, live);
    let folder = preview.join(folder_name(me.0, me.1)?);
    std::fs::create_dir(&folder)?;
    std::fs::create_dir(folder.join("s"))?;
    std::fs::create_dir(folder.join("c"))?;
    std::fs::write(folder.join(EMPTY_CONFIG), b"")?;
    Ok((folder, leftovers))
}

/// The leftover shadow folders (plan.md D14): a folder of a gone process, or an own folder that no live context holds.
fn leftovers(preview: &Path, me: (u32, u64), live: &HashSet<PathBuf>) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(preview) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(parse_name)
                .is_some_and(|owner| leftover(owner, me, live.contains(path)))
        })
        .collect()
}

/// Plan.md D14: an own folder that no live context holds, or a folder whose owner process record is gone, is a leftover.
pub(crate) fn leftover(owner: (u32, u64), me: (u32, u64), held: bool) -> bool {
    if owner == me {
        !held
    } else {
        gone(owner.0, owner.1)
    }
}

/// Removes one shadow folder. `std::fs::remove_dir_all` opens each entry relative to its folder and never follows a link
/// (Rust 1.58.1, CVE-2022-21658), as plan.md D14 needs.
pub(crate) fn remove(folder: &Path) {
    let _ = std::fs::remove_dir_all(folder);
}

/// Contract Δ6: the fixed arrays that an `ignorePreview` context admits (plan.md D9, D14).
/// On Windows, the arrays that read or write a working-tree file carry `-c core.longpaths=true` after `--no-lazy-fetch`.
pub(crate) fn fits(arguments: &[String], windows: bool) -> bool {
    let items: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let long = if windows {
        &["--no-lazy-fetch", "-c", "core.longpaths=true"][..]
    } else {
        &["--no-lazy-fetch"][..]
    };
    let with_long = |tail: &[&str]| items.strip_prefix(long) == Some(tail);
    const CHECKOUT: [&str; 7] = [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "checkout-index",
        "-a",
        "-f",
    ];
    let checkout = |prefix: bool| {
        items.strip_prefix(long).is_some_and(|rest| {
            rest.strip_prefix(&CHECKOUT[..])
                == Some(if prefix {
                    &["--prefix=.git/info/"][..]
                } else {
                    &[][..]
                })
        })
    };
    match items.as_slice() {
        ["--no-lazy-fetch", "init", "-q", "--template="] => true,
        [
            "--no-lazy-fetch",
            "hash-object",
            "-w",
            "--no-filters",
            "--stdin",
        ] => true,
        ["--no-lazy-fetch", "update-index", "-z", "--index-info"] => true,
        _ => {
            with_long(&["hash-object", "-w", "--no-filters", "--stdin-paths"])
                || with_long(&["hash-object", "--no-filters", "--stdin-paths"])
                || checkout(false)
                || checkout(true)
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
        ["-c", case, tail @ ..] if is_ignorecase(case) => match tail {
            ["-c", excludes, tail @ ..] if excludes.starts_with("core.excludesFile=") => tail,
            tail => tail,
        },
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
    fn create_makes_the_two_repositories_and_names_the_leftovers() {
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
        let (folder, mut leftovers) = create(&launch, me, &HashSet::new()).expect("create");
        assert!(folder.join("s").is_dir() && folder.join("c").is_dir());
        assert_eq!(
            std::fs::read(folder.join(EMPTY_CONFIG)).expect("empty config"),
            b""
        );
        leftovers.sort();
        let mut expected = vec![gone, own];
        expected.sort();
        assert_eq!(
            leftovers, expected,
            "a folder of a gone process and an own folder no context holds"
        );
    }

    #[test]
    fn create_keeps_a_live_own_folder() {
        let fixture = crate::jobs::tests::Fixture::new();
        let launch = fixture.path("launch");
        std::fs::create_dir_all(&launch).expect("launch");
        let me = self_identity();
        let (folder, _) = create(&launch, me, &HashSet::new()).expect("first");
        let mut live = HashSet::new();
        live.insert(folder.clone());
        let (second, leftovers) = create(&launch, me, &live).expect("second");
        assert!(
            leftovers.is_empty(),
            "a held own folder is no leftover: {leftovers:?}"
        );
        assert!(folder.exists() && second.exists());
    }

    /// Contract Δ6: the accepted arrays, with `-c core.longpaths=true` on Windows for the working-tree arrays.
    #[test]
    fn fits_admits_only_the_contract_arrays() {
        let a = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(fits(
            &a(&["--no-lazy-fetch", "init", "-q", "--template="]),
            true
        ));
        assert!(fits(
            &a(&["--no-lazy-fetch", "update-index", "-z", "--index-info"]),
            true
        ));
        assert!(fits(
            &a(&[
                "--no-lazy-fetch",
                "hash-object",
                "-w",
                "--no-filters",
                "--stdin"
            ]),
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
        assert!(
            !fits(
                &a(&[
                    "--no-lazy-fetch",
                    "hash-object",
                    "-w",
                    "--no-filters",
                    "--stdin-paths"
                ]),
                true
            ),
            "a Windows `--stdin-paths` without core.longpaths is refused"
        );
        assert!(
            fits(
                &a(&[
                    "--no-lazy-fetch",
                    "hash-object",
                    "-w",
                    "--no-filters",
                    "--stdin-paths"
                ]),
                false
            ),
            "WSL needs no core.longpaths"
        );
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
            &[
                "--no-lazy-fetch",
                "-c",
                "core.ignorecase=maybe",
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
                "-v",
                "-n",
            ][..],
            &[
                "--no-lazy-fetch",
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
                "-v",
                "-n",
            ][..],
        ] {
            assert!(!fits(&a(bad), false), "{bad:?}");
        }
        // Contract Δ6: the two `checkout-index` forms, with `-c core.longpaths=true` first on Windows.
        let checkout = [
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.eol=lf",
            "checkout-index",
            "-a",
            "-f",
        ];
        let long = ["--no-lazy-fetch", "-c", "core.longpaths=true"];
        let form = |head: &[&str], prefix: bool| {
            let mut items: Vec<&str> = head.to_vec();
            items.extend(checkout);
            if prefix {
                items.push("--prefix=.git/info/");
            }
            a(&items)
        };
        for prefix in [false, true] {
            assert!(
                fits(&form(&long, prefix), true),
                "the Windows form, prefix {prefix}"
            );
            assert!(
                fits(&form(&["--no-lazy-fetch"], prefix), false),
                "the WSL form, prefix {prefix}"
            );
            assert!(
                !fits(&form(&["--no-lazy-fetch"], prefix), true),
                "a Windows form without core.longpaths, prefix {prefix}"
            );
            assert!(
                !fits(&form(&long, prefix), false),
                "a WSL form with core.longpaths, prefix {prefix}"
            );
        }
        // The near misses: `checkout-index` without the line-end options.
        for windows in [false, true] {
            for tail in [
                &["checkout-index", "-a", "-f"][..],
                &["checkout-index", "-a", "-f", "--prefix=.git/info/"][..],
            ] {
                let mut items: Vec<&str> = if windows {
                    long.to_vec()
                } else {
                    vec!["--no-lazy-fetch"]
                };
                items.extend(tail);
                assert!(!fits(&a(&items), windows), "{items:?}");
            }
        }
    }

    /// Plan.md D14: only `ERROR_INVALID_PARAMETER` from `OpenProcess` means that no process has the PID.
    /// Another failure keeps the folder. A process with the PID and another creation time is another process.
    #[test]
    fn only_a_missing_pid_or_another_creation_time_means_gone() {
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER};
        assert!(gone_by(Err(ERROR_INVALID_PARAMETER.to_hresult()), 7));
        assert!(
            !gone_by(Err(ERROR_ACCESS_DENIED.to_hresult()), 7),
            "access denied keeps the folder"
        );
        assert!(
            !gone_by(Ok(None), 7),
            "a failed GetProcessTimes keeps the folder"
        );
        assert!(gone_by(Ok(Some(8)), 7), "another creation time");
        assert!(!gone_by(Ok(Some(7)), 7));
        let me = self_identity();
        assert_eq!(
            process_created(me.0),
            Ok(Some(me.1)),
            "the own process record"
        );
        // Microsoft Learn `OpenProcess`: PID 0 fails with `ERROR_INVALID_PARAMETER`, the error of a PID without a process.
        assert_eq!(
            process_created(0),
            Err(ERROR_INVALID_PARAMETER.to_hresult()),
            "the OpenProcess error code"
        );
    }
}
