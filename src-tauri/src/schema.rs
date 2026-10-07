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
use crate::wsl::WslIdentity;

const INVALID: Code = "INVALID_REQUEST";
/// Contract §5 "Submodule review": at most 256 submodules.
const SUBMODULE_PATHS: usize = 256;
/// Contract §6 "Channel frames" `limits.deadlineMs`: a WSL distro start probe has at most 60 seconds.
pub const WSL_START_DEADLINE_MS: u64 = 60_000;

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
    progress,
    wsl_request,
    process_request,
    process_reply,
    mutation_reply,
    trust_reply
);

/// serde also reads a struct from a JSON array, but the schema permits only an object there.
/// So the typed value must encode to the JSON shape of its input.
pub(crate) fn typed<T: DeserializeOwned + Serialize>(value: &Value) -> Result<T, Code> {
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

/// A WSL `process` request (contract §6 "Channel frames", §11). typify drops the `deadlineMs` range and the `confirm: true` constant.
pub fn wsl_request(value: &Value) -> Result<wsl_request::WslRequest, Code> {
    use wsl_request::WslRequest;
    let request: WslRequest = typed(value)?;
    let fits = match &request {
        WslRequest::WslDistros { .. } => true,
        WslRequest::WslProbe { limits, .. } => limits.deadline_ms.get() <= WSL_START_DEADLINE_MS,
        WslRequest::Register { confirm, .. } => *confirm,
    };
    if fits { Ok(request) } else { Err(INVALID) }
}

/// One record holds one identity form, and a WSL record holds one distro GUID (gaps.md W2).
/// JSON Schema has neither rule nor the 64-bit inode bound, so the shell checks them here.
fn one_identity_form(record: &Value) -> bool {
    let identities = [
        &record["commonIdentity"],
        &record["worktreeIdentity"][0],
        &record["worktreeIdentity"][1],
    ];
    let wsl: Vec<Option<WslIdentity>> = identities.iter().map(|v| WslIdentity::parse(v)).collect();
    let windows = identities.iter().all(|v| v.get("volumeSerial").is_some());
    windows
        || wsl
            .iter()
            .all(|w| w.as_ref().map(|w| &w.guid) == wsl[0].as_ref().map(|w| &w.guid) && w.is_some())
}

/// A stored trust record in the handshake form (contract §7 "Trust approval store"), within 4 KiB of JSON (contract §5).
pub fn trust_record(value: &Value) -> bool {
    typed::<trust_record::TrustRecord>(value).is_ok()
        && one_identity_form(value)
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

/// The replies of contract §6 "Process replies", "Recovery markers", and §7 "Trust approval store".
/// typify drops `const` values, so each builder writes them. Each `type` value and each `const` value has one site here.
pub mod reply {
    use std::fmt::Debug;
    use std::str::FromStr;

    use serde::Serialize;
    use serde_json::Value;

    use super::{mutation_reply as m, process_reply as p, trust_reply as t, typed};
    use crate::bootstrap::PhysicalIdentity;
    use crate::process_requests::Code;

    const DEADLINE: &str = "deadline";
    const APPROVED: &str = "approved";
    const DECLINED: &str = "declined";

    /// A field value that the shell built inside its schema rule, such as a call ID that passed `is_identifier`.
    /// A failure is a defect of the shell, never of a request.
    fn field<T: FromStr<Err: Debug>>(text: &str) -> T {
        text.parse()
            .expect("the shell builds each reply field inside its schema rule")
    }

    /// A component number of a fact: at most the entry path length.
    fn count(component: usize) -> i64 {
        i64::try_from(component).expect("a component number fits in i64")
    }

    fn encode(reply: impl Serialize) -> Value {
        serde_json::to_value(reply).expect("a generated reply type encodes to JSON")
    }

    fn process(reply: p::ProcessReply) -> Value {
        encode(reply)
    }

    pub fn output(call_id: &str, stream: p::OutputStream, base64: &str) -> Value {
        process(p::ProcessReply::Output {
            call_id: field(call_id),
            data: field(base64),
            stream,
            type_: "output".into(),
        })
    }

    pub fn input_written(call_id: &str) -> Value {
        process(p::ProcessReply::InputWritten {
            call_id: field(call_id),
            type_: "inputWritten".into(),
        })
    }

    /// `exit_code` `None` encodes as `null`.
    pub fn exit(
        call_id: &str,
        exit_code: Option<u32>,
        active_descendants: u32,
        deadline: Option<p::ExitDeadline>,
    ) -> Value {
        process(p::ProcessReply::Exit {
            active_descendants: active_descendants.into(),
            call_id: field(call_id),
            deadline,
            exit_code,
            type_: "exit".into(),
        })
    }

    /// The `refused` reply of a `process` frame. The shell refuses only with a contract §6 refused code.
    pub fn refused(call_id: &str, code: Code) -> Value {
        process(p::ProcessReply::Refused {
            call_id: field(call_id),
            code: field(code),
            type_: "refused".into(),
        })
    }

    pub fn identity(call_id: &str, identities: Vec<p::IdentityListIdentitiesItem>) -> Value {
        process(p::ProcessReply::IdentityGroup(p::IdentityGroup::List {
            call_id: field(call_id),
            identities,
            type_: "identity".into(),
        }))
    }

    pub fn identity_deadline(call_id: &str) -> Value {
        process(p::ProcessReply::IdentityGroup(p::IdentityGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "identity".into(),
        }))
    }

    /// One identity of an `identity` reply (contract §6 "Process fields").
    pub fn identity_of(identity: &PhysicalIdentity) -> p::IdentityListIdentitiesItem {
        match identity {
            PhysicalIdentity::Windows(identity) => {
                let (volume_serial, file_id) = identity.hex();
                p::IdentityListIdentitiesItem::FileIdentity {
                    file_id: field(&file_id),
                    volume_serial: field(&volume_serial),
                }
            }
            PhysicalIdentity::Wsl(identity) => p::IdentityListIdentitiesItem::WslIdentity {
                distro_guid: field(&identity.guid),
                file_system_id: field(&identity.file_system_id),
                inode: field(&identity.inode),
            },
        }
    }

    /// An identity entry that holds no identity.
    pub fn identity_refused(
        reason: Option<p::IdentityRefusedReason>,
    ) -> p::IdentityListIdentitiesItem {
        p::IdentityListIdentitiesItem::IdentityRefused {
            code: "UNSUPPORTED_REPOSITORY".into(),
            reason,
        }
    }

    pub fn lingering_count(call_id: &str, count: u32) -> Value {
        process(p::ProcessReply::LingeringCountGroup(
            p::LingeringCountGroup::Reply {
                call_id: field(call_id),
                count: count.into(),
                type_: "lingeringCount".into(),
            },
        ))
    }

    pub fn lingering_count_deadline(call_id: &str) -> Value {
        process(p::ProcessReply::LingeringCountGroup(
            p::LingeringCountGroup::Deadline {
                call_id: field(call_id),
                deadline: DEADLINE.into(),
                type_: "lingeringCount".into(),
            },
        ))
    }

    pub fn register(call_id: &str, result: p::RegisterResultResult) -> Value {
        process(p::ProcessReply::RegisterGroup(p::RegisterGroup::Result {
            call_id: field(call_id),
            result,
            type_: "register".into(),
        }))
    }

    /// A new `gitProbe` context for the picked file.
    pub fn register_another(call_id: &str, bootstrap_id: &str, executable_path: &str) -> Value {
        process(p::ProcessReply::RegisterGroup(p::RegisterGroup::Another {
            bootstrap_id: field(bootstrap_id),
            call_id: field(call_id),
            executable_path: field(executable_path),
            result: "another".into(),
            type_: "register".into(),
        }))
    }

    pub fn register_deadline(call_id: &str) -> Value {
        process(p::ProcessReply::RegisterGroup(p::RegisterGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "register".into(),
        }))
    }

    pub fn resolve_git(call_id: &str, bootstrap_id: &str) -> Value {
        process(p::ProcessReply::ResolveGitGroup(
            p::ResolveGitGroup::Reply {
                bootstrap_id: field(bootstrap_id),
                call_id: field(call_id),
                type_: "resolveGit".into(),
            },
        ))
    }

    pub fn resolve_git_deadline(call_id: &str) -> Value {
        process(p::ProcessReply::ResolveGitGroup(
            p::ResolveGitGroup::Deadline {
                call_id: field(call_id),
                deadline: DEADLINE.into(),
                type_: "resolveGit".into(),
            },
        ))
    }

    pub fn file_facts(call_id: &str, facts: Vec<p::FileFactsReplyFactsItem>) -> Value {
        process(p::ProcessReply::FileFactsGroup(p::FileFactsGroup::Reply {
            call_id: field(call_id),
            facts,
            type_: "fileFacts".into(),
        }))
    }

    pub fn file_facts_deadline(call_id: &str) -> Value {
        process(p::ProcessReply::FileFactsGroup(
            p::FileFactsGroup::Deadline {
                call_id: field(call_id),
                deadline: DEADLINE.into(),
                type_: "fileFacts".into(),
            },
        ))
    }

    /// A `link` fact. Only a `symlink` or a `junction` holds `target` and `relative`.
    pub fn link_fact(
        component: usize,
        target: Option<(p::FileFactLinkTag, p::FileFactLinkTarget, bool)>,
    ) -> p::FileFactsReplyFactsItem {
        let component = count(component);
        match target {
            Some((tag, target, relative)) => p::FileFactsReplyFactsItem::Link {
                component,
                relative: Some(relative),
                tag,
                target: Some(target),
            },
            None => p::FileFactsReplyFactsItem::Link {
                component,
                relative: None,
                tag: p::FileFactLinkTag::Other,
                target: None,
            },
        }
    }

    /// An `error` fact.
    pub fn error_fact(component: usize, code: p::FileFactErrorCode) -> p::FileFactsReplyFactsItem {
        p::FileFactsReplyFactsItem::Error {
            code,
            component: count(component),
        }
    }

    /// The `lastWrite` text of a `file` fact: a signed 64-bit integer in decimal.
    pub fn last_write(stamp: i64) -> p::FileFactFileLastWrite {
        field(&stamp.to_string())
    }

    /// The `digest` of a `file` fact: 64 lowercase hex digits.
    pub fn digest(hex: &str) -> p::FileFactFileDigest {
        field(hex)
    }

    /// The reply holds the context path alone for a path without a WSL prefix.
    pub fn wsl_distros_path(call_id: &str, path: &str) -> Value {
        process(p::ProcessReply::WslDistrosGroup(p::WslDistrosGroup::Path {
            call_id: field(call_id),
            path: field(path),
            type_: "wslDistros".into(),
        }))
    }

    /// Each list entry passed the contract §11 "Distro checks" of `wsl.rs`.
    pub fn wsl_distros_facts(
        call_id: &str,
        path: &str,
        wsl_executable: &str,
        listed: &[String],
        running: &[String],
        keys: Vec<p::WslDistrosFactsKeysItem>,
        saved: Vec<p::WslDistrosFactsSavedItem>,
    ) -> Value {
        process(p::ProcessReply::WslDistrosGroup(
            p::WslDistrosGroup::Facts {
                call_id: field(call_id),
                keys,
                listed: listed.iter().map(|name| field(name)).collect(),
                path: field(path),
                running: running.iter().map(|name| field(name)).collect(),
                saved,
                type_: "wslDistros".into(),
                wsl_executable: field(wsl_executable),
            },
        ))
    }

    pub fn wsl_distros_key(guid: &str, name: &str, version: u32) -> p::WslDistrosFactsKeysItem {
        p::WslDistrosFactsKeysItem {
            guid: field(guid),
            name: field(name),
            version: version.into(),
        }
    }

    pub fn wsl_distros_saved(
        guid: &str,
        distro: &str,
        git: &str,
        version: &str,
        git_identity: &str,
    ) -> p::WslDistrosFactsSavedItem {
        p::WslDistrosFactsSavedItem {
            distro: field(distro),
            git: field(git),
            git_identity: field(git_identity),
            guid: field(guid),
            version: field(version),
        }
    }

    /// Contract §11 "Distro checks": a missing `wsl.exe` or a failed list call.
    pub fn wsl_distros_unavailable(call_id: &str, path: &str) -> Value {
        process(p::ProcessReply::WslDistrosGroup(
            p::WslDistrosGroup::Unavailable {
                call_id: field(call_id),
                code: "WSL_UNAVAILABLE".into(),
                path: field(path),
                reason: "wsl-missing".into(),
                type_: "wslDistros".into(),
            },
        ))
    }

    fn mutation(reply: m::MutationReply) -> Value {
        encode(reply)
    }

    pub fn started_marker(call_id: &str, marker_id: &str) -> Value {
        mutation(m::MutationReply::StartedGroup(m::StartedGroup::Marker {
            call_id: field(call_id),
            marker_id: field(marker_id),
            type_: "started".into(),
        }))
    }

    pub fn started_busy(call_id: &str) -> Value {
        mutation(m::MutationReply::StartedGroup(m::StartedGroup::Busy {
            busy: true,
            call_id: field(call_id),
            type_: "started".into(),
        }))
    }

    /// `failure` is `disk-full`, `access-denied`, or `other`. `folder` is the `recovery` folder.
    pub fn started_failure(call_id: &str, failure: &str, folder: &str) -> Value {
        mutation(m::MutationReply::StartedGroup(m::StartedGroup::Failure {
            call_id: field(call_id),
            failure: field(failure),
            folder: field(folder),
            type_: "started".into(),
        }))
    }

    pub fn started_deadline(call_id: &str) -> Value {
        mutation(m::MutationReply::StartedGroup(m::StartedGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "started".into(),
        }))
    }

    pub fn mutation_refused(call_id: &str, code: Code) -> Value {
        mutation(m::MutationReply::Refused {
            call_id: field(call_id),
            code: field(code),
            type_: "refused".into(),
        })
    }

    fn trust(reply: t::TrustReply) -> Value {
        encode(reply)
    }

    pub fn confirm_declined(call_id: &str) -> Value {
        trust(t::TrustReply::ConfirmGroup(t::ConfirmGroup::Declined {
            call_id: field(call_id),
            result: DECLINED.into(),
            type_: "confirm".into(),
        }))
    }

    /// `stored: false`: the approval holds for the session only.
    pub fn confirm_session(call_id: &str) -> Value {
        trust(t::TrustReply::ConfirmGroup(t::ConfirmGroup::Session {
            call_id: field(call_id),
            result: APPROVED.into(),
            stored: false,
            type_: "confirm".into(),
        }))
    }

    /// `record` passed `schema::trust_record` before the store wrote it.
    pub fn confirm_stored(call_id: &str, record: &Value) -> Value {
        trust(t::TrustReply::ConfirmGroup(t::ConfirmGroup::Stored {
            call_id: field(call_id),
            record: typed(record).expect("a stored trust record passed its schema check"),
            result: APPROVED.into(),
            stored: true,
            type_: "confirm".into(),
        }))
    }

    pub fn confirm_run(call_id: &str, result: t::ConfirmRunReplyResult) -> Value {
        trust(t::TrustReply::ConfirmRunReply {
            call_id: field(call_id),
            result,
            type_: "confirmRun".into(),
        })
    }

    pub fn revoke(call_id: &str, ended_processes: u32) -> Value {
        trust(t::TrustReply::RevokeGroup(t::RevokeGroup::Reply {
            call_id: field(call_id),
            ended_processes: ended_processes.into(),
            type_: "revoke".into(),
        }))
    }

    pub fn revoke_deadline(call_id: &str) -> Value {
        trust(t::TrustReply::RevokeGroup(t::RevokeGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "revoke".into(),
        }))
    }

    pub fn trust_refused(call_id: &str, code: Code) -> Value {
        trust(t::TrustReply::Refused {
            call_id: field(call_id),
            code: field(code),
            type_: "refused".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    use serde_json::json;

    use crate::bootstrap::{Identity, PhysicalIdentity};
    use crate::process_requests::decode_strict;

    /// The golden vector file form of `tests/contracts/vectors.test.ts`.
    #[derive(serde::Deserialize)]
    struct Vector {
        schema: String,
        text: String,
        expected: String,
    }

    /// The `platform` value of the vectors that run on this host.
    const HOST_PLATFORM: &str = if cfg!(windows) { "windows" } else { "posix" };

    /// Whether the vector file runs on this host. serde reads `null` as an absent `Option`, so the raw value decides.
    fn runs_here(file: &str, path: &Path) -> bool {
        let file: Value = serde_json::from_str(file).expect("vector form");
        match file.get("platform") {
            None => true,
            Some(Value::String(platform)) if platform == HOST_PLATFORM => true,
            Some(Value::String(platform)) if platform == "windows" || platform == "posix" => false,
            Some(other) => panic!("{}: unknown platform {other}", path.display()),
        }
    }

    /// The vector schemas that the shell reads into no generated type. The renderer and the service check them.
    /// The shell writes process, mutation, and trust replies and never reads them. It reads only the `requestId` of a response.
    /// The shell forwards the registration, trust, workspace, entries, and history results in `Response.result` and reads no field of them.
    const NOT_READ: [&str; 12] = [
        "process-reply",
        "mutation-reply",
        "trust-reply",
        "renderer-envelope",
        "response",
        "registration-result",
        "read-trust-result",
        "approve-trust-result",
        "revoke-trust-result",
        "read-workspace-result",
        "read-entries-result",
        "read-history-result",
    ];

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
            "wsl-request" => strict(text).and_then(|value| wsl_request(&value).map(drop)),
            // `ProcessRequests::dispatch` reads the `type` value, then its generated type (contract §6 "Channel frames").
            // Only `fileFacts` vectors exist.
            "process-request" => match strict(text) {
                Ok(value) if value["type"] == "fileFacts" => {
                    typed(&value).and_then(|request| crate::file_facts::parse(&request).map(drop))
                }
                _ => return None,
            },
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
                if !runs_here(&text, &path) {
                    continue;
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
            if cfg!(windows) { 72 } else { 67 },
            "shell-read vectors"
        );
    }

    /// Each reply builder of `reply` against the wire form of its variant: a golden vector where one exists, else the contract §6 or §7 form.
    #[test]
    fn each_reply_builder_gives_the_wire_form_of_its_variant() {
        use process_reply::{
            ExitDeadline, FileFactErrorCode, FileFactLinkTag, FileFactsReplyFactsItem as Fact,
            IdentityRefusedReason, OutputStream, RegisterResultResult,
        };
        use trust_reply::ConfirmRunReplyResult;

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors/valid");
        println!("ORIGIN {}", root.display());
        let vector = |name: &str| -> Value {
            let path = root.join(name);
            let text = std::fs::read_to_string(&path).expect("vector file");
            let vector: Vector = serde_json::from_str(&text).expect("vector form");
            serde_json::from_str(&vector.text).expect("vector text")
        };
        let call = "0f0f0f0f-0000-4000-8000-000000000001";
        let other = "0f0f0f0f-0000-4000-8000-000000000002";
        let deadline = |kind: &str| json!({ "type": kind, "callId": call, "deadline": "deadline" });
        let windows = PhysicalIdentity::Windows(Identity {
            volume_serial: 0xab,
            file_id: [0x11; 16],
        });
        let wsl = PhysicalIdentity::Wsl(WslIdentity {
            guid: "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}".to_string(),
            file_system_id: "fedc9aa3bd65bc57".to_string(),
            inode: "43750".to_string(),
        });
        let record = json!({
            "commonDirectory": "C:\\repo\\.git",
            "commonIdentity": windows.reply(),
            "worktreeRoot": "C:\\repo",
            "gitDirectory": "C:\\repo\\.git",
            "worktreeIdentity": [windows.reply(), windows.reply()],
            "configurationFingerprint": "a".repeat(64),
            "approvedAt": "2026-10-07T10:00:00Z",
            "gitSelectedPath": "C:\\Git\\cmd\\git.exe",
        });
        assert!(trust_record(&record), "{record}");
        let facts = vec![
            Fact::File {
                bound: None,
                digest: Some(reply::digest(&"a".repeat(64))),
                executable: None,
                last_write: reply::last_write(133_700_000_000_000_000),
                owner_execute: None,
                size: 12,
            },
            Fact::Directory { executable: None },
            reply::link_fact(
                1,
                Some((
                    FileFactLinkTag::Symlink,
                    "../../scripts/h.sh".try_into().expect("link text"),
                    true,
                )),
            ),
            Fact::Absent,
            Fact::Other,
            reply::error_fact(1, FileFactErrorCode::AccessDenied),
        ];
        let cases = [
            (
                reply::output(call, OutputStream::Stderr, "YWJj"),
                json!({ "type": "output", "callId": call, "stream": "stderr", "data": "YWJj" }),
            ),
            (
                reply::input_written(call),
                json!({ "type": "inputWritten", "callId": call }),
            ),
            (
                reply::exit(
                    "0f0f0f0f-0000-4000-8000-000000000003",
                    Some(4_294_967_295),
                    0,
                    None,
                ),
                vector("process-exit-largest-code.json"),
            ),
            (
                reply::exit(call, None, 2, Some(ExitDeadline::Deadline)),
                json!({ "type": "exit", "callId": call, "exitCode": null, "activeDescendants": 2, "deadline": "deadline" }),
            ),
            (
                reply::refused(call, "GIT_CHANGED"),
                json!({ "type": "refused", "callId": call, "code": "GIT_CHANGED" }),
            ),
            (
                reply::identity(
                    call,
                    vec![
                        reply::identity_of(&windows),
                        reply::identity_of(&wsl),
                        reply::identity_refused(Some(IdentityRefusedReason::NoFsUuid)),
                        reply::identity_refused(None),
                    ],
                ),
                json!({ "type": "identity", "callId": call, "identities": [
                    { "volumeSerial": "00000000000000ab", "fileId": "11".repeat(16) },
                    { "distroGuid": "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", "fileSystemId": "fedc9aa3bd65bc57", "inode": "43750" },
                    { "code": "UNSUPPORTED_REPOSITORY", "reason": "no-fs-uuid" },
                    { "code": "UNSUPPORTED_REPOSITORY" },
                ] }),
            ),
            (
                reply::identity_deadline(call),
                vector("identity-reply-deadline.json"),
            ),
            (
                reply::lingering_count(call, 3),
                json!({ "type": "lingeringCount", "callId": call, "count": 3 }),
            ),
            (
                reply::lingering_count_deadline(call),
                vector("lingering-count-reply-deadline.json"),
            ),
            (
                reply::register(call, RegisterResultResult::Approved),
                json!({ "type": "register", "callId": call, "result": "approved" }),
            ),
            (
                reply::register(call, RegisterResultResult::Declined),
                json!({ "type": "register", "callId": call, "result": "declined" }),
            ),
            (
                reply::register_another(call, other, "C:\\Git\\bin\\git.exe"),
                json!({ "type": "register", "callId": call, "result": "another", "bootstrapId": other, "executablePath": "C:\\Git\\bin\\git.exe" }),
            ),
            (
                reply::register_deadline(call),
                vector("register-reply-deadline.json"),
            ),
            (
                reply::resolve_git(call, other),
                json!({ "type": "resolveGit", "callId": call, "bootstrapId": other }),
            ),
            (
                reply::resolve_git_deadline(call),
                vector("resolve-git-reply-deadline.json"),
            ),
            (
                reply::file_facts(call, facts),
                vector("file-facts-reply.json"),
            ),
            (
                reply::file_facts_deadline(call),
                vector("file-facts-reply-deadline.json"),
            ),
            (
                reply::wsl_distros_path(call, "C:\\repo"),
                json!({ "type": "wslDistros", "callId": call, "path": "C:\\repo" }),
            ),
            (
                reply::wsl_distros_facts(
                    call,
                    "\\\\wsl.localhost\\Ubuntu\\r",
                    "C:\\Windows\\system32\\wsl.exe",
                    &["Ubuntu".to_string()],
                    &[],
                    vec![reply::wsl_distros_key(
                        "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}",
                        "Ubuntu",
                        2,
                    )],
                    vec![reply::wsl_distros_saved(
                        "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}",
                        "Ubuntu",
                        "/usr/bin/git",
                        "2.55.0",
                        "fedc9aa3bd65bc57:43750:4066232:1751487822",
                    )],
                ),
                json!({
                    "type": "wslDistros", "callId": call, "path": "\\\\wsl.localhost\\Ubuntu\\r",
                    "wslExecutable": "C:\\Windows\\system32\\wsl.exe", "listed": ["Ubuntu"], "running": [],
                    "keys": [{ "guid": "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", "name": "Ubuntu", "version": 2 }],
                    "saved": [{ "guid": "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", "distro": "Ubuntu", "git": "/usr/bin/git", "version": "2.55.0", "gitIdentity": "fedc9aa3bd65bc57:43750:4066232:1751487822" }],
                }),
            ),
            (
                reply::wsl_distros_unavailable(call, "\\\\wsl$\\Ubuntu\\r"),
                json!({ "type": "wslDistros", "callId": call, "path": "\\\\wsl$\\Ubuntu\\r", "code": "WSL_UNAVAILABLE", "reason": "wsl-missing" }),
            ),
            (
                reply::started_marker(call, other),
                json!({ "type": "started", "callId": call, "markerId": other }),
            ),
            (
                reply::started_busy(call),
                json!({ "type": "started", "callId": call, "busy": true }),
            ),
            (
                reply::started_failure(call, "disk-full", "C:\\data\\recovery"),
                json!({ "type": "started", "callId": call, "failure": "disk-full", "folder": "C:\\data\\recovery" }),
            ),
            (
                reply::started_deadline(call),
                vector("started-reply-deadline.json"),
            ),
            (
                reply::mutation_refused(call, "INVALID_REQUEST"),
                json!({ "type": "refused", "callId": call, "code": "INVALID_REQUEST" }),
            ),
            (
                reply::confirm_declined(call),
                json!({ "type": "confirm", "callId": call, "result": "declined" }),
            ),
            (
                reply::confirm_session(call),
                json!({ "type": "confirm", "callId": call, "result": "approved", "stored": false }),
            ),
            (
                reply::confirm_stored(call, &record),
                json!({ "type": "confirm", "callId": call, "result": "approved", "stored": true, "record": record }),
            ),
            (
                reply::confirm_run(call, ConfirmRunReplyResult::Declined),
                json!({ "type": "confirmRun", "callId": call, "result": "declined" }),
            ),
            (
                reply::revoke(call, 4),
                json!({ "type": "revoke", "callId": call, "endedProcesses": 4 }),
            ),
            (
                reply::revoke_deadline(call),
                vector("revoke-reply-deadline.json"),
            ),
            (
                reply::trust_refused(call, "PROCESS_OWNERSHIP_FAILED"),
                json!({ "type": "refused", "callId": call, "code": "PROCESS_OWNERSHIP_FAILED" }),
            ),
        ];
        assert_eq!(deadline("identity"), vector("identity-reply-deadline.json"));
        for (built, expected) in cases {
            assert!(
                same_shape(&expected, &built) && built == expected,
                "{built} != {expected}"
            );
        }
    }

    #[test]
    fn a_reply_group_reads_through_its_generated_type() {
        let deadline = json!({ "type": "identity", "callId": "0f0f0f0f-0000-4000-8000-000000000001", "deadline": "deadline" });
        assert!(typed::<process_reply::IdentityGroup>(&deadline).is_ok());
    }

    #[test]
    #[should_panic(expected = "unknown platform null")]
    fn a_vector_with_a_null_platform_is_refused() {
        runs_here(r#"{"platform":null}"#, Path::new("null-platform.json"));
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
