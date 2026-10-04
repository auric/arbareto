// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! The serde types that `build.rs` generates with typify from `src/contracts/schemas/` (contract §1 "Schemas").
//! typify drops `const` values and integer ranges, and it counts characters, not UTF-16 units.
//! Each function below adds those checks to the generated type.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::process_requests::{Code, path};
use crate::settings::{TRUST_RECORD_BYTES, utc_time};

const INVALID: Code = "INVALID_REQUEST";
/// Contract §5 "Submodule review": at most 256 submodules.
const SUBMODULE_PATHS: usize = 256;

macro_rules! generated {
    ($($module:ident),*) => {
        $(
            #[allow(dead_code, clippy::all, clippy::pedantic, reason = "typify output")]
            pub mod $module {
                include!(concat!(env!("OUT_DIR"), "/", stringify!($module), ".rs"));
            }
        )*
    };
}

generated!(
    native_first_envelope,
    mutation_request,
    trust_request,
    trust_record,
    handshake,
    progress
);

/// serde also reads a struct from a JSON array, but the schema permits only an object there.
/// So the typed value must encode to the JSON shape of its input.
fn typed<T: DeserializeOwned + Serialize>(value: &Value) -> Result<T, Code> {
    let typed = T::deserialize(value).map_err(|_| INVALID)?;
    let encoded = serde_json::to_value(&typed).map_err(|_| INVALID)?;
    if same_shape(value, &encoded) {
        Ok(typed)
    } else {
        Err(INVALID)
    }
}

/// Equal keys, lengths, and scalars. A number matches any number, because typify reads `version` as `f64`.
fn same_shape(input: &Value, encoded: &Value) -> bool {
    match (input, encoded) {
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, v)| b.get(key).is_some_and(|w| same_shape(v, w)))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(v, w)| same_shape(v, w))
        }
        (Value::Number(_), Value::Number(_)) => true,
        _ => input == encoded,
    }
}

/// The path rule of contract §6 "Channel frames" for each present key.
fn paths(value: &Value, keys: &[&str]) -> Result<(), Code> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .try_for_each(|text| path(text).map(drop))
}

/// A native-first renderer envelope (contract §1 step 6). The generated `version` is `f64`, so `1.0` would pass it.
/// The code order follows `src/contracts/envelope.ts` `validateRequest`.
pub fn native_first(value: &Value) -> Result<native_first_envelope::NativeFirstEnvelope, Code> {
    match value.get("version") {
        None => Err(INVALID),
        Some(version) if version.as_u64() != Some(1) => Err("PROTOCOL_VERSION"),
        Some(_) => typed(value),
    }
}

/// A `mutation` frame body (contract §6 "Mutation frames").
pub fn mutation_request(value: &Value) -> Result<mutation_request::MutationRequest, Code> {
    let request = typed(value)?;
    paths(value, &["worktreeRoot", "commonDirectory"])?;
    Ok(request)
}

/// A `trust` frame body (contract §6 "Trust frames").
pub fn trust_request(value: &Value) -> Result<trust_request::TrustRequest, Code> {
    use trust_request::TrustRequest;
    let request = typed(value)?;
    paths(
        value,
        &[
            "worktreeRoot",
            "gitDirectory",
            "commonDirectory",
            "gitSelectedPath",
        ],
    )?;
    match &request {
        // `bound` comes only with `persist: false`.
        TrustRequest::Confirm { persist, bound, .. } if *persist == bound.is_some() => Err(INVALID),
        TrustRequest::ConfirmRun {
            program_count,
            unchecked_count,
            submodule_paths,
            ..
        } => {
            let unchecked = u64::try_from(*unchecked_count).map_err(|_| INVALID)?;
            if unchecked > program_count.get()
                || !(1..=SUBMODULE_PATHS).contains(&submodule_paths.len())
            {
                return Err(INVALID);
            }
            value["submodulePaths"]
                .as_array()
                .ok_or(INVALID)?
                .iter()
                .try_for_each(|text| path(text).map(drop))?;
            Ok(request)
        }
        _ => Ok(request),
    }
}

/// A stored trust record in the handshake form (contract §7 "Trust approval store"), within 4 KiB of JSON (contract §5).
pub fn trust_record(value: &Value) -> bool {
    typed::<trust_record::TrustRecord>(value).is_ok()
        && paths(
            value,
            &[
                "commonDirectory",
                "worktreeRoot",
                "gitDirectory",
                "gitSelectedPath",
            ],
        )
        .is_ok()
        && value["approvedAt"].as_str().and_then(utc_time).is_some()
        && value.to_string().len() <= TRUST_RECORD_BYTES
}

/// The handshake that the shell builds (contract §6 "Startup handshake").
#[cfg(test)]
pub fn handshake(value: &Value) -> Result<handshake::Handshake, Code> {
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(INVALID);
    }
    typed(value)
}

/// A progress event with exactly the contract §2 fields and nonnegative counters.
pub fn progress(value: &Value) -> bool {
    typed::<progress::Progress>(value)
        .is_ok_and(|event| event.counters.values().all(|count| *count >= 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    use serde_json::json;

    use crate::process_requests::decode_strict;

    /// The golden vector file form of `tests/contracts/vectors.test.ts`.
    #[derive(serde::Deserialize)]
    struct Vector {
        schema: String,
        text: String,
        expected: String,
        platform: Option<String>,
    }

    /// The `platform` value of the vectors that run on this host.
    const HOST_PLATFORM: &str = if cfg!(windows) { "windows" } else { "posix" };

    /// The vector schemas that the shell never reads. The renderer and the service check them.
    const NOT_READ: [&str; 2] = ["process-reply", "renderer-envelope"];

    /// The result of the shell code path for one vector. `None`: the shell reads no value of that schema.
    fn check(schema: &str, text: &str) -> Option<String> {
        let ok = |checked: Result<(), Code>| {
            checked.map_or_else(str::to_string, |()| "valid".to_string())
        };
        let strict = |text: &str| decode_strict(text).ok_or(INVALID);
        let valid = |valid: bool| if valid { Ok(()) } else { Err(INVALID) };
        Some(ok(match schema {
            "native-first-envelope" => {
                strict(text).and_then(|value| native_first(&value).map(drop))
            }
            "mutation-request" => strict(text).and_then(|value| mutation_request(&value).map(drop)),
            "trust-request" => strict(text).and_then(|value| trust_request(&value).map(drop)),
            "trust-record" => strict(text).and_then(|value| valid(trust_record(&value))),
            "handshake" => strict(text).and_then(|value| handshake(&value).map(drop)),
            "progress" => strict(text).and_then(|value| valid(progress(&value))),
            other if NOT_READ.contains(&other) => return None,
            other => panic!("unknown vector schema {other}"),
        }))
    }

    #[test]
    fn the_golden_vectors_give_their_expected_results_in_the_shell() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors");
        println!("ORIGIN {}", root.display());
        let mut checked = 0;
        let mut wrong = Vec::new();
        for kind in ["valid", "invalid"] {
            for entry in std::fs::read_dir(root.join(kind)).expect("vector folder") {
                let path = entry.expect("entry").path();
                let text = std::fs::read_to_string(&path).expect("vector file");
                let vector: Vector = serde_json::from_str(&text).expect("vector form");
                assert_eq!(
                    vector.expected == "valid",
                    kind == "valid",
                    "{}",
                    path.display()
                );
                match vector.platform.as_deref() {
                    None => {}
                    Some(platform) if platform == HOST_PLATFORM => {}
                    Some("windows" | "posix") => continue,
                    Some(other) => panic!("{}: unknown platform {other}", path.display()),
                }
                let Some(result) = check(&vector.schema, &vector.text) else {
                    continue;
                };
                checked += 1;
                if result != vector.expected {
                    wrong.push(format!(
                        "{}: {result}, expected {}",
                        path.display(),
                        vector.expected
                    ));
                }
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
        assert_eq!(
            checked,
            if cfg!(windows) { 51 } else { 48 },
            "shell-read vectors"
        );
    }

    #[test]
    fn a_native_first_renderer_payload_with_any_other_field_is_refused() {
        let envelope = |operation: &str, payload: Value| json!({ "version": 1, "sessionId": "0f0f0f0f-0000-4000-8000-0000000000aa", "requestId": "0f0f0f0f-0000-4000-8000-000000000001", "operation": operation, "payload": payload });
        for operation in ["chooseGit", "chooseRepository", "restoreWorkspace"] {
            assert!(
                native_first(&envelope(operation, json!({}))).is_ok(),
                "{operation}"
            );
            for payload in [
                json!({ "executablePath": "C:\\Git\\cmd\\git.exe" }),
                json!({ "path": "C:\\repo" }),
                json!({ "fingerprint": "a".repeat(64) }),
                json!([]),
                json!(null),
            ] {
                assert_eq!(
                    native_first(&envelope(operation, payload.clone())).map(drop),
                    Err(INVALID),
                    "{operation} {payload}"
                );
            }
        }
        let marker_id = "0f0f0f0f-0000-4000-8000-000000000002";
        assert!(
            native_first(&envelope(
                "dismissRecoveryMarker",
                json!({ "markerId": marker_id })
            ))
            .is_ok()
        );
        for payload in [
            json!({ "markerId": marker_id, "worktreeRoot": "C:\\elsewhere" }),
            json!({ "markerId": marker_id, "bootstrapId": marker_id }),
            json!({}),
        ] {
            assert_eq!(
                native_first(&envelope("dismissRecoveryMarker", payload.clone())).map(drop),
                Err(INVALID),
                "{payload}"
            );
        }
    }
}
