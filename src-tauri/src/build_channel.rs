// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

/// The build channel of `ARBARETO_RELEASE_CHANNEL` (feature 007 data-model §1).
/// `identity` is the build identity with its optional `-dirty` suffix.
pub fn resolve(value: Option<&str>, identity: &str) -> Result<&'static str, String> {
    match value {
        None | Some("") => Ok("local"),
        Some("preview") if identity.ends_with("-dirty") => {
            Err(format!("a preview build needs a clean tree: {identity}"))
        }
        Some("preview") => Ok("preview"),
        Some(other) => Err(format!(
            "ARBARETO_RELEASE_CHANNEL must be unset, empty, or preview, not {other:?}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn an_unset_or_empty_channel_gives_local() {
        assert_eq!(resolve(None, COMMIT), Ok("local"));
        assert_eq!(resolve(Some(""), COMMIT), Ok("local"));
    }

    #[test]
    fn preview_gives_preview() {
        assert_eq!(resolve(Some("preview"), COMMIT), Ok("preview"));
    }

    #[test]
    fn any_other_channel_value_fails() {
        for value in ["Preview", "release", "local", " preview"] {
            assert!(resolve(Some(value), COMMIT).is_err(), "{value}");
        }
    }

    #[test]
    fn preview_refuses_a_dirty_identity_and_local_keeps_it() {
        let dirty = format!("{COMMIT}-dirty");
        assert!(resolve(Some("preview"), &dirty).is_err());
        assert_eq!(resolve(None, &dirty), Ok("local"));
        assert_eq!(resolve(Some(""), &dirty), Ok("local"));
    }
}
