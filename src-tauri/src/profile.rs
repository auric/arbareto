// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

/// Names the profile root for tests and measurements. Unset keeps the Tauri app folders.
pub const VARIABLE: &str = "ARBARETO_PROFILE_ROOT";

/// The folders that the shell writes.
pub struct Folders {
    pub config: PathBuf,
    pub data: PathBuf,
    /// The service launch directory (contract §7). `None` keeps the Tauri app local data folder.
    pub launch: Option<PathBuf>,
    /// `None` keeps the Tauri default WebView2 data folder.
    pub webview: Option<PathBuf>,
}

impl Folders {
    pub fn under(root: &Path) -> Folders {
        let data = root.join("data");
        Folders {
            config: root.join("config"),
            launch: Some(data.clone()),
            data,
            webview: Some(root.join("webview2")),
        }
    }
}

#[derive(Debug)]
pub enum Refusal {
    Relative(PathBuf),
    Unreadable(PathBuf, std::io::Error),
    NotFolder(PathBuf),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Relative(path) => {
                write!(
                    f,
                    "{VARIABLE} is not an absolute path: \"{}\".",
                    path.display()
                )
            }
            Refusal::Unreadable(path, error) => {
                write!(
                    f,
                    "{VARIABLE} names no readable folder: \"{}\". {error}.",
                    path.display()
                )
            }
            Refusal::NotFolder(path) => {
                write!(
                    f,
                    "{VARIABLE} names a file, not a folder: \"{}\".",
                    path.display()
                )
            }
        }
    }
}

/// Checks a value of `VARIABLE`. The root must be an absolute path to an existing folder.
pub fn root(value: Option<OsString>) -> Result<Option<PathBuf>, Refusal> {
    let Some(value) = value else {
        return Ok(None);
    };
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return Err(Refusal::Relative(root));
    }
    match std::fs::metadata(&root) {
        Ok(metadata) if metadata.is_dir() => Ok(Some(root)),
        Ok(_) => Err(Refusal::NotFolder(root)),
        Err(error) => Err(Refusal::Unreadable(root, error)),
    }
}

/// Shows the refusal on stderr and in a native message, then exits with code 2. It writes no file.
#[cfg(windows)]
pub fn refuse(refusal: &Refusal) -> ! {
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    use windows::core::HSTRING;

    let text = format!("Arbareto cannot start. {refusal}");
    eprintln!("{text}");
    // SAFETY: both strings are live for the call, and the message has no owner window.
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from("Arbareto"),
            MB_OK | MB_ICONERROR,
        )
    };
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let path = std::env::temp_dir()
                .join(format!("arbareto-profile-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir(&path).expect("create fixture folder");
            Fixture(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn unset_keeps_the_default_folders() {
        assert!(root(None).expect("unset").is_none());
    }

    #[test]
    fn accepts_an_existing_absolute_folder() {
        let fixture = Fixture::new("valid");
        let value = Some(fixture.0.clone().into_os_string());
        assert_eq!(root(value).expect("valid"), Some(fixture.0.clone()));
    }

    #[test]
    fn refuses_a_relative_path() {
        for value in ["profile", r".\profile", r"\profile", "C:profile", ""] {
            assert!(
                matches!(root(Some(value.into())), Err(Refusal::Relative(_))),
                "{value:?}"
            );
        }
    }

    #[test]
    fn refuses_a_missing_folder() {
        let fixture = Fixture::new("missing");
        let value = Some(fixture.0.join("absent").into_os_string());
        assert!(matches!(root(value), Err(Refusal::Unreadable(..))));
    }

    #[test]
    fn refuses_a_file() {
        let fixture = Fixture::new("file");
        let file = fixture.0.join("profile.txt");
        std::fs::write(&file, "x").expect("write fixture file");
        assert!(matches!(
            root(Some(file.into_os_string())),
            Err(Refusal::NotFolder(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn places_every_folder_under_the_root() {
        let root = Path::new(r"C:\profile");
        let folders = Folders::under(root);
        assert_eq!(folders.config, Path::new(r"C:\profile\config"));
        assert_eq!(folders.data, Path::new(r"C:\profile\data"));
        assert_eq!(
            folders.launch.as_deref(),
            Some(Path::new(r"C:\profile\data"))
        );
        assert_eq!(
            folders.webview.as_deref(),
            Some(Path::new(r"C:\profile\webview2"))
        );
    }
}
