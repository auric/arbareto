// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;

/// Bun 1.4.2 reads each name at startup. Research R7 lists each read site.
const STARTUP_CONTROLS: [&str; 30] = [
    "BUN_BE_BUN",
    "BUN_OPTIONS",
    "BUN_FEATURE_FLAG_NO_ORPHANS",
    "BUN_DISABLE_STOP_IF_NECESSARY_TIMER",
    "BUN_GC_TIMER_INTERVAL",
    "BUN_GC_RUNS_UNTIL_SKIP_RELEASE_ACCESS",
    "BUN_GC_TIMER_DISABLE",
    "BUN_IDLE_GC_SECONDS",
    "HYPERFINE_RANDOMIZED_ENVIRONMENT_OFFSET",
    "BUN_INSPECT",
    "BUN_INSPECT_CONNECT_TO",
    "BUN_INSPECT_NOTIFY",
    "BUN_INSPECT_PRELOAD",
    "NODE_PENDING_DEPRECATION",
    "NODE_USE_SYSTEM_CA",
    "_BUN_WATCHER_CHILD",
    "NODE_ENV",
    "BUN_ENV",
    "BUN_DISABLE_TRANSPILER",
    "BUN_CONFIG_MAX_HTTP_REQUESTS",
    "BUN_SHOW_BUN_STACKFRAMES",
    "BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_PRESERVE_SYMLINKS",
    "BUN_GARBAGE_COLLECTOR_LEVEL",
    "BUN_FEATURE_FLAG_FORCE_WAITER_THREAD",
    "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING",
    "BUN_FEATURE_FLAG_SYNTHETIC_MEMORY_LIMIT",
    "BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE",
];

/// Each name after `BUN_JSC_` sets one JSC option.
const STARTUP_CONTROL_PREFIX: &str = "BUN_JSC_";

/// Removes each runtime-control variable that the pinned Bun 1.4.2 reads at startup (contract §7). Names match without case.
pub fn sanitize(environment: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(name, _)| {
            !name_starts_with(name, STARTUP_CONTROL_PREFIX)
                && !STARTUP_CONTROLS
                    .iter()
                    .any(|control| name_is(name, control))
        })
        .collect()
}

/// Matches an ASCII name without ASCII letter case. Bun 1.4.2 uses this rule on Windows (research R7).
pub(crate) fn name_is(name: &OsStr, ascii: &str) -> bool {
    name.len() == ascii.len() && name_starts_with(name, ascii)
}

pub(crate) fn name_starts_with(name: &OsStr, ascii: &str) -> bool {
    let mut units = name.encode_wide();
    ascii.bytes().all(|byte| {
        units
            .next()
            .and_then(|unit| u8::try_from(unit).ok())
            .is_some_and(|unit| unit.eq_ignore_ascii_case(&byte))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bun 744846f844374847c902b5e7fd59b4342a51ef99 reads these names between process entry and the entry module of a compiled executable on Windows.
    const STARTUP_CONTROLS: [&str; 38] = [
        "BUN_BE_BUN",
        "BUN_OPTIONS",
        "BUN_FEATURE_FLAG_NO_ORPHANS",
        "BUN_DISABLE_STOP_IF_NECESSARY_TIMER",
        "BUN_GC_TIMER_INTERVAL",
        "BUN_GC_RUNS_UNTIL_SKIP_RELEASE_ACCESS",
        "BUN_GC_TIMER_DISABLE",
        "BUN_IDLE_GC_SECONDS",
        "HYPERFINE_RANDOMIZED_ENVIRONMENT_OFFSET",
        "BUN_INSPECT",
        "BUN_INSPECT_CONNECT_TO",
        "BUN_INSPECT_NOTIFY",
        "BUN_INSPECT_PRELOAD",
        "NODE_PENDING_DEPRECATION",
        "NODE_USE_SYSTEM_CA",
        "_BUN_WATCHER_CHILD",
        "NODE_ENV",
        "BUN_ENV",
        "BUN_DISABLE_TRANSPILER",
        "BUN_CONFIG_MAX_HTTP_REQUESTS",
        "BUN_SHOW_BUN_STACKFRAMES",
        "BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER",
        "NODE_CHANNEL_FD",
        "NODE_CHANNEL_SERIALIZATION_MODE",
        "NODE_PRESERVE_SYMLINKS",
        "BUN_GARBAGE_COLLECTOR_LEVEL",
        "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING",
        "BUN_FEATURE_FLAG_FORCE_WAITER_THREAD",
        "BUN_FEATURE_FLAG_SYNTHETIC_MEMORY_LIMIT",
        "BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE",
        // `BUN_JSC_` is a prefix: each name after it sets one JSC option (jsc/bindings/ZigGlobalObject.cpp:363-377).
        "BUN_JSC_useJIT",
        "BUN_JSC_enableRestrictedOptions",
        "BUN_JSC_",
        "BUN_JSC_validateOptions",
        "BUN_JSC_useConcurrentJIT",
        "BUN_JSC_logGC",
        "BUN_JSC_dumpOptions",
        "BUN_JSC_jitPolicyScale",
    ];

    const UNRELATED: [(&str, &str); 14] = [
        ("PATH", r"C:\Windows\system32;C:\Program Files\Git\cmd"),
        ("SystemRoot", r"C:\Windows"),
        ("windir", r"C:\Windows"),
        ("TEMP", r"C:\Users\u\AppData\Local\Temp"),
        ("TMP", r"C:\Users\u\AppData\Local\Temp"),
        ("USERPROFILE", r"C:\Users\u"),
        ("HOME", r"C:\Users\u"),
        ("APPDATA", r"C:\Users\u\AppData\Roaming"),
        ("LOCALAPPDATA", r"C:\Users\u\AppData\Local"),
        ("LANG", "de_DE.UTF-8"),
        ("GIT_CONFIG_GLOBAL", r"C:\Users\u\.gitconfig"),
        ("ARBARETO_MARKER", "kept"),
        ("XBUN_OPTIONS", "--suffix-only"),
        ("MY_BUN_BE_BUN", "1"),
    ];

    fn pairs(entries: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        entries
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn names(environment: &[(OsString, OsString)]) -> Vec<String> {
        environment
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn every_startup_runtime_control_variable_is_removed() {
        let mut input: Vec<(&str, &str)> =
            STARTUP_CONTROLS.iter().map(|name| (*name, "1")).collect();
        input.push(("BUN_OPTIONS", ""));
        let output = names(&sanitize(pairs(&input)));
        for name in STARTUP_CONTROLS {
            assert!(
                !output.iter().any(|n| n.eq_ignore_ascii_case(name)),
                "{name} reaches the service"
            );
        }
        assert!(output.is_empty(), "left: {output:?}");
    }

    #[test]
    fn name_matching_ignores_letter_case() {
        let input = [
            ("bun_be_bun", "1"),
            ("Bun_Options", "--inspect"),
            ("bun_inspect", "ws://127.0.0.1:9229"),
            ("Bun_Inspect_Preload", r"C:\x\preload.ts"),
            ("bun_jsc_usejit", "false"),
            ("Bun_Jsc_EnableRestrictedOptions", "true"),
            ("node_channel_fd", "3"),
            ("Node_Env", "development"),
            ("_bun_watcher_child", "1"),
        ];
        let output = names(&sanitize(pairs(&input)));
        assert!(output.is_empty(), "left: {output:?}");
    }

    #[test]
    fn unrelated_variables_stay_unchanged() {
        let mut input: Vec<(&str, &str)> = UNRELATED.to_vec();
        input.push(("BUN_BE_BUN", "1"));
        input.push(("BUN_OPTIONS", "--preload=x"));
        let output = sanitize(pairs(&input));
        let mut kept: Vec<(String, String)> = output
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        let mut expected: Vec<(String, String)> = UNRELATED
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        kept.sort();
        expected.sort();
        assert_eq!(kept, expected, "unrelated names and values stay");
    }
}
