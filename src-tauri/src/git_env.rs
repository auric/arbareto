// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;

use crate::env_sanitize::{name_is, name_starts_with};

struct Policy {
    remove: Vec<String>,
    remove_prefixes: Vec<String>,
    set: Vec<(String, String)>,
    index_file_variable: Option<String>,
}

fn policies() -> &'static HashMap<String, Policy> {
    static POLICIES: OnceLock<HashMap<String, Policy>> = OnceLock::new();
    POLICIES.get_or_init(|| {
        let json: Value =
            serde_json::from_str(include_str!("../../src/contracts/git-environment.json"))
                .expect("git-environment.json is valid JSON");
        let strings = |value: &Value| -> Vec<String> {
            value
                .as_array()
                .expect("a string array")
                .iter()
                .map(|item| item.as_str().expect("a string").to_string())
                .collect()
        };
        json["policies"]
            .as_object()
            .expect("a policies object")
            .iter()
            .map(|(id, policy)| {
                let set = policy["set"]
                    .as_object()
                    .expect("a set object")
                    .iter()
                    .map(|(name, value)| {
                        (name.clone(), value.as_str().expect("a string").to_string())
                    })
                    .collect();
                let policy = Policy {
                    remove: strings(&policy["remove"]),
                    remove_prefixes: strings(&policy["removePrefixes"]),
                    set,
                    index_file_variable: policy["indexFileVariable"].as_str().map(str::to_string),
                };
                (id.clone(), policy)
            })
            .collect()
    })
}

/// Builds a Git child environment from `base` and one fixed policy of `src/contracts/git-environment.json` (contract §7).
/// `index_file` comes only from a service-owned `transactionId`. A policy without an index file variable refuses it with `INVALID_REQUEST`.
pub fn child_environment(
    policy: &str,
    base: &[(OsString, OsString)],
    index_file: Option<&Path>,
) -> Result<Vec<(OsString, OsString)>, &'static str> {
    let policy = policies().get(policy).ok_or("INVALID_REQUEST")?;
    let index_file = match (&policy.index_file_variable, index_file) {
        (None, Some(_)) => return Err("INVALID_REQUEST"),
        (Some(name), Some(path)) => Some((OsString::from(name), path.as_os_str().to_owned())),
        _ => None,
    };
    let mut environment: Vec<(OsString, OsString)> = base
        .iter()
        .filter(|(name, _)| {
            !policy.remove.iter().any(|removed| name_is(name, removed))
                && !policy
                    .remove_prefixes
                    .iter()
                    .any(|prefix| name_starts_with(name, prefix))
                && !policy.set.iter().any(|(set, _)| name_is(name, set))
        })
        .cloned()
        .collect();
    environment.extend(
        policy
            .set
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value))),
    );
    environment.extend(index_file);
    Ok(environment)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    const POLICIES: &str = include_str!("../../src/contracts/git-environment.json");

    // Git for Windows 52ca1113d651127f89477a8763f86ab20f645e1d, Documentation/git.adoc:501-601 ("The Git Repository").
    const REPOSITORY_VARIABLES: [&str; 13] = [
        "GIT_INDEX_FILE",
        "GIT_INDEX_VERSION",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_NAMESPACE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_COMMON_DIR",
        "GIT_DEFAULT_HASH",
        "GIT_DEFAULT_REF_FORMAT",
        "GIT_REFERENCE_BACKEND",
    ];

    const CONFIG_AND_IDENTITY: [(&str, &str); 11] = [
        ("GIT_CONFIG_PARAMETERS", "'core.hookspath'='C:/hooks'"),
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "user.signingkey"),
        ("GIT_CONFIG_VALUE_0", "ABCDEF"),
        ("GIT_AUTHOR_NAME", "Env Author"),
        ("GIT_AUTHOR_EMAIL", "author@example.invalid"),
        ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00+0000"),
        ("GIT_COMMITTER_NAME", "Env Committer"),
        ("GIT_COMMITTER_EMAIL", "committer@example.invalid"),
        ("GIT_COMMITTER_DATE", "2026-01-02T00:00:00+0000"),
        ("EMAIL", "email@example.invalid"),
    ];

    const CONFIG_SELECTION: [(&str, &str); 3] = [
        ("GIT_CONFIG_GLOBAL", r"C:\owned\global.gitconfig"),
        ("GIT_CONFIG_SYSTEM", r"C:\owned\system.gitconfig"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
    ];

    const AUTHENTICATION: [(&str, &str); 6] = [
        ("GIT_SSH_COMMAND", "ssh -i C:/keys/id"),
        ("GIT_ASKPASS", r"C:\tools\askpass.exe"),
        ("SSH_ASKPASS", r"C:\tools\ssh-askpass.exe"),
        ("GCM_INTERACTIVE", "never"),
        ("GCM_TRACE", r"C:\logs\gcm.log"),
        ("GCM_CREDENTIAL_STORE", "wincredman"),
    ];

    const FIXED: [&str; 4] = ["probe", "read", "mutation", "search"];

    fn policy_ids() -> Vec<String> {
        let json: serde_json::Value = serde_json::from_str(POLICIES).expect("git-environment.json");
        json["policies"]
            .as_object()
            .expect("policies object")
            .keys()
            .cloned()
            .collect()
    }

    fn pairs(entries: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        entries
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn base(extra: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        let mut entries = vec![
            ("PATH", r"C:\Windows\system32"),
            ("SystemRoot", r"C:\Windows"),
            ("HOME", r"C:\Users\u"),
            ("USERPROFILE", r"C:\Users\u"),
        ];
        entries.extend_from_slice(extra);
        pairs(&entries)
    }

    /// Every value of `name` in `environment`, matched without case.
    fn values(environment: &[(OsString, OsString)], name: &str) -> Vec<String> {
        environment
            .iter()
            .filter(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .collect()
    }

    fn build(policy: &str, base: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
        child_environment(policy, base, None).unwrap_or_else(|code| panic!("{policy}: {code}"))
    }

    #[test]
    fn the_fixed_policy_identifiers_build_an_environment() {
        let ids = policy_ids();
        for id in FIXED {
            assert!(
                ids.iter().any(|p| p == id),
                "git-environment.json lists {id}"
            );
        }
        for id in &ids {
            build(id, &base(&[]));
        }
        for unknown in ["custom", "", "Probe", "MUTATION"] {
            assert_eq!(
                child_environment(unknown, &base(&[]), None),
                Err("INVALID_REQUEST"),
                "{unknown:?} is not a fixed identifier"
            );
        }
    }

    #[test]
    fn hostile_repository_variables_never_reach_a_child() {
        let mut hostile: Vec<(&str, &str)> = REPOSITORY_VARIABLES
            .iter()
            .map(|name| (*name, r"C:\attacker\repo"))
            .collect();
        hostile.push(("git_dir", r"C:\attacker\lower"));
        hostile.push(("Git_Index_File", r"C:\attacker\index"));
        for id in policy_ids() {
            let output = build(&id, &base(&hostile));
            for name in REPOSITORY_VARIABLES {
                assert!(
                    values(&output, name).is_empty(),
                    "{id}: {name} reaches the child"
                );
            }
        }
        let owned = PathBuf::from(r"C:\repo\.git\arbareto-candidate-0123");
        let output =
            child_environment("mutation", &base(&hostile), Some(&owned)).expect("mutation");
        assert_eq!(
            values(&output, "GIT_INDEX_FILE"),
            vec![owned.to_string_lossy().into_owned()],
            "only the owned index file reaches the child"
        );
        assert!(values(&output, "GIT_DIR").is_empty());
    }

    #[test]
    fn home_and_userprofile_stay() {
        for id in policy_ids() {
            let output = build(&id, &base(&[]));
            assert_eq!(values(&output, "HOME"), vec![r"C:\Users\u"], "{id}");
            assert_eq!(values(&output, "USERPROFILE"), vec![r"C:\Users\u"], "{id}");
            assert_eq!(
                values(&output, "PATH"),
                vec![r"C:\Windows\system32"],
                "{id}"
            );
        }
    }

    #[test]
    fn configuration_and_identity_variables_reach_every_child_unchanged() {
        for id in policy_ids() {
            let output = build(&id, &base(&CONFIG_AND_IDENTITY));
            for (name, value) in CONFIG_AND_IDENTITY {
                assert_eq!(values(&output, name), vec![value], "{id}: {name}");
            }
        }
    }

    #[test]
    fn git_config_reaches_only_a_mutation_child() {
        let input = base(&[("GIT_CONFIG", r"C:\other\config")]);
        assert!(
            values(&build("probe", &input), "GIT_CONFIG").is_empty(),
            "probe removes GIT_CONFIG"
        );
        assert!(
            values(&build("read", &input), "GIT_CONFIG").is_empty(),
            "read removes GIT_CONFIG"
        );
        assert_eq!(
            values(&build("mutation", &input), "GIT_CONFIG"),
            vec![r"C:\other\config"],
            "mutation keeps GIT_CONFIG for hooks"
        );
    }

    #[test]
    fn global_and_system_configuration_selection_reaches_every_child_unchanged() {
        let json: serde_json::Value = serde_json::from_str(POLICIES).expect("git-environment.json");
        for id in policy_ids() {
            let preserved: Vec<&str> = json["policies"][&id]["preserve"]
                .as_array()
                .expect("preserve")
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            let output = build(&id, &base(&CONFIG_SELECTION));
            for (name, value) in CONFIG_SELECTION {
                assert!(
                    preserved.contains(&name),
                    "{id}: the JSON lists {name} as preserved"
                );
                assert_eq!(values(&output, name), vec![value], "{id}: {name}");
            }
        }
    }

    #[test]
    fn every_policy_removes_each_git_test_variable() {
        let input = base(&[
            ("GIT_TEST_SPLIT_INDEX", "1"),
            ("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1"),
            ("git_test_fsmonitor", "x"),
            ("GIT_TEST_", "1"),
        ]);
        for id in policy_ids() {
            let output = build(&id, &input);
            let left: Vec<String> = output
                .iter()
                .map(|(k, _)| k.to_string_lossy().into_owned())
                .filter(|k| k.to_ascii_uppercase().starts_with("GIT_TEST_"))
                .collect();
            assert!(left.is_empty(), "{id}: {left:?}");
            assert!(
                values(&output, "GIT_TEST_SPLIT_INDEX").is_empty(),
                "{id}: GIT_TEST_SPLIT_INDEX reaches the child"
            );
        }
    }

    #[test]
    fn every_policy_sets_git_terminal_prompt_to_zero() {
        for input in [
            base(&[]),
            base(&[("GIT_TERMINAL_PROMPT", "1")]),
            base(&[("git_terminal_prompt", "1")]),
        ] {
            for id in policy_ids() {
                assert_eq!(
                    values(&build(&id, &input), "GIT_TERMINAL_PROMPT"),
                    vec!["0"],
                    "{id}"
                );
            }
        }
    }

    /// Feature 002 contract Δ7: `search` is the `read` policy plus `LC_ALL=C.UTF-8`.
    #[test]
    fn search_is_the_read_policy_with_a_fixed_c_utf8_locale() {
        use crate::schema::process_request::EnvironmentPolicy;
        let policy: EnvironmentPolicy = serde_json::from_value(serde_json::json!("search"))
            .expect("the generated type holds search");
        assert_eq!(policy.to_string(), "search");
        for input in [
            base(&[]),
            base(&[("LC_ALL", "de_DE.UTF-8"), ("GIT_DIR", r"C:\x")]),
            base(&[("lc_all", "fr_FR")]),
        ] {
            let search = build(&policy.to_string(), &input);
            assert_eq!(values(&search, "LC_ALL"), vec!["C.UTF-8"]);
            let mut read = build("read", &input);
            read.retain(|(name, _)| !name.eq_ignore_ascii_case("LC_ALL"));
            read.push(("LC_ALL".into(), "C.UTF-8".into()));
            assert_eq!(search, read);
        }
    }

    #[test]
    fn probe_sets_a_fixed_c_locale() {
        for input in [
            base(&[]),
            base(&[("LC_ALL", "de_DE.UTF-8")]),
            base(&[("lc_all", "fr_FR")]),
        ] {
            assert_eq!(values(&build("probe", &input), "LC_ALL"), vec!["C"]);
        }
    }

    #[test]
    fn only_mutation_sets_the_index_file_from_a_transaction() {
        let owned = PathBuf::from(r"C:\repo\.git\arbareto-candidate-4567");
        let hostile = base(&[("GIT_INDEX_FILE", r"C:\attacker\index")]);
        let with = child_environment("mutation", &hostile, Some(&owned))
            .expect("mutation with an index file");
        assert_eq!(
            values(&with, "GIT_INDEX_FILE"),
            vec![owned.to_string_lossy().into_owned()]
        );
        let without =
            child_environment("mutation", &hostile, None).expect("mutation without an index file");
        assert!(
            values(&without, "GIT_INDEX_FILE").is_empty(),
            "no transaction gives no index file"
        );
        for id in ["probe", "read"] {
            assert_eq!(
                child_environment(id, &hostile, Some(&owned)),
                Err("INVALID_REQUEST"),
                "{id} refuses an index file"
            );
        }
    }

    #[test]
    fn no_policy_sets_or_removes_authentication_variables() {
        for id in policy_ids() {
            let output = build(&id, &base(&AUTHENTICATION));
            for (name, value) in AUTHENTICATION {
                assert_eq!(values(&output, name), vec![value], "{id}: {name}");
            }
            let bare = build(&id, &base(&[]));
            for (name, _) in AUTHENTICATION {
                assert!(values(&bare, name).is_empty(), "{id} sets {name}");
            }
            assert!(
                !bare
                    .iter()
                    .any(|(k, _)| k.to_string_lossy().to_ascii_uppercase().starts_with("GCM_")),
                "{id} sets a GCM_ variable"
            );
        }
    }
}
