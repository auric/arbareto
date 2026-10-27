// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 007 plan.md D7 and contracts/release.md §5: the URL of each `openReleaseLink` target.

/// A `local` build has no release.
pub const UNAVAILABLE: &str = "RELEASE_LINK_UNAVAILABLE";
pub const OPEN_FAILED: &str = "RELEASE_LINK_OPEN_FAILED";
const INVALID: &str = "INVALID_REQUEST";

/// The URL of `target` for a build of `channel`, `repository` (`CARGO_PKG_REPOSITORY`), `version`, and `commit`.
pub fn url(
    channel: &str,
    repository: &str,
    version: &str,
    commit: &str,
    target: &str,
) -> Result<String, &'static str> {
    let url = match target {
        "hunspell-source" => format!(
            "{repository}/releases/download/v{version}/arbareto-{version}-hunspell-source.tar.gz"
        ),
        "tag-source" => format!("{repository}/tree/{commit}"),
        _ => return Err(INVALID),
    };
    // `build_channel.rs` admits only `local` and `preview`.
    if channel != "preview" {
        return Err(UNAVAILABLE);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPOSITORY: &str = "https://github.com/auric/arbareto";
    const COMMIT: &str = "c950776a2b4e0c2f6f7e6b1d9a1f3c5e7d9b0a12";

    #[test]
    fn a_preview_build_gives_the_two_contract_urls() {
        assert_eq!(
            url("preview", REPOSITORY, "0.1.0", COMMIT, "hunspell-source").as_deref(),
            Ok(
                "https://github.com/auric/arbareto/releases/download/v0.1.0/arbareto-0.1.0-hunspell-source.tar.gz"
            )
        );
        assert_eq!(
            url("preview", REPOSITORY, "0.1.0", COMMIT, "tag-source").as_deref(),
            Ok("https://github.com/auric/arbareto/tree/c950776a2b4e0c2f6f7e6b1d9a1f3c5e7d9b0a12")
        );
    }

    #[test]
    fn a_local_build_has_no_release_link() {
        for target in ["hunspell-source", "tag-source"] {
            assert_eq!(
                url("local", REPOSITORY, "0.1.0", COMMIT, target),
                Err(UNAVAILABLE),
                "{target}"
            );
        }
    }

    #[test]
    fn any_other_target_fails_validation() {
        for channel in ["preview", "local"] {
            for target in [
                "",
                "Tag-Source",
                "hunspell-source ",
                "https://example.test/",
            ] {
                assert_eq!(
                    url(channel, REPOSITORY, "0.1.0", COMMIT, target),
                    Err(INVALID),
                    "{channel} {target:?}"
                );
            }
        }
    }
}
