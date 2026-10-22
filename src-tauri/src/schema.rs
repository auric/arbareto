// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! The serde types that `build.rs` generates with typify from `src/contracts/schemas/` (contract §1 "Schemas").
//! typify drops `const` values and integer ranges, and it counts characters, not UTF-16 units.
//! Each function below adds those checks to the generated type.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::close::Mutation;
use crate::process_requests::{Code, path};
use crate::settings::{TRUST_RECORD_BYTES, utc_time};
use crate::wsl::WslIdentity;

const INVALID: Code = Code::InvalidRequest;
/// Contract §5 "Submodule review": at most 256 submodules.
const SUBMODULE_PATHS: usize = 256;
/// Contract §6 "Channel frames" `limits.deadlineMs`: a WSL distro start probe has at most 60 seconds.
pub const WSL_START_DEADLINE_MS: u64 = 60_000;
/// Feature 003 contract Δ3 `clone`: `src/contracts/limits.ts` `CLONE_URL_BYTES`.
const CLONE_URL_BYTES: usize = 4096;
/// Feature 003 contract Δ2: the counters of the `sync` and `clone` phases.
const SYNC_COUNTERS: [&str; 3] = ["percent", "remoteIndex", "remoteCount"];
/// Feature 004 contract Δ5 "Trust dialog names per kind": `src/contracts/channel.ts` `TRUST_DIALOG_NAMES`.
const TRUST_DIALOG_NAMES: usize = 20;
/// Feature 004 contract Δ5 "Branch name": 255 UTF-8 bytes.
const BRANCH_NAME_BYTES: usize = 255;
/// Feature 004 data-model §1: a local branch lies under this prefix.
const LOCAL_BRANCH_PREFIX: &str = "refs/heads/";

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
/// So the typed value must encode to the JSON shape of its input. `None`: the value is outside the schema.
pub(crate) fn typed<T: DeserializeOwned + Serialize>(value: &Value) -> Option<T> {
    let typed = T::deserialize(value).ok()?;
    let encoded = serde_json::to_value(&typed).ok()?;
    same_shape(value, &encoded).then_some(typed)
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
pub fn native_first(
    value: &Value,
) -> Result<native_first_envelope::NativeFirstEnvelope, &'static str> {
    let envelope = match value.get("version") {
        None => return Err("INVALID_REQUEST"),
        Some(version) if version.as_u64() != Some(1) => return Err("PROTOCOL_VERSION"),
        Some(_) => typed(value).ok_or("INVALID_REQUEST")?,
    };
    let payload = &value["payload"];
    let fits = match value["operation"].as_str() {
        // Feature 003 contract Δ3 `clone`. typify counts the characters of the URL, not its bytes.
        Some("clone") => {
            payload["url"].as_str().is_some_and(|url| {
                (1..=CLONE_URL_BYTES).contains(&url.len()) && !url.chars().any(char::is_control)
            }) && paths(payload, &["destination"]).is_ok()
        }
        // Data-model §10: a key file belongs to one worktree and remote. The other targets name neither.
        Some("chooseSyncPath" | "clearSyncPath") => {
            let key = payload["target"] == "remoteKey";
            key == payload.get("worktreeKey").is_some() && key == payload.get("remote").is_some()
        }
        // Feature 004 contract Δ1 and Δ3: typify drops the `action` const, the byte bound of a new name, and the
        // `refs/heads/` prefix of an existing branch.
        Some("reviewWorkbench") => {
            let branch = &payload["branch"];
            let named = match (branch["new"].as_str(), branch["existing"].as_str()) {
                (Some(name), None) => (1..=BRANCH_NAME_BYTES).contains(&name.len()),
                (None, Some(name)) => name
                    .strip_prefix(LOCAL_BRANCH_PREFIX)
                    .is_some_and(|short| !short.is_empty()),
                _ => false,
            };
            payload["action"] == "worktree-add" && named && paths(payload, &["path"]).is_ok()
        }
        // Feature 005 contract Δ3 `openSubmodule`: each `/` component follows the 001 §6 component rule.
        Some("openSubmodule") => payload["path"]
            .as_str()
            .is_some_and(|path| path.split('/').all(crate::file_facts::is_component)),
        _ => true,
    };
    if fits {
        Ok(envelope)
    } else {
        Err("INVALID_REQUEST")
    }
}

/// A `mutation` frame body (contract §6 "Mutation frames"). JSON Schema has no rule that ties `direction` or `action` to `kind`.
pub fn mutation_request(
    value: &Value,
) -> Result<mutation_request::MutationRequest, mutation_reply::RefusedCode> {
    let request = typed(value).ok_or(INVALID)?;
    paths(value, &["worktreeRoot", "commonDirectory"])?;
    if let mutation_request::MutationRequest::Started {
        kind,
        direction,
        action,
        ..
    } = &request
    {
        Mutation::of(*kind, *direction, *action).ok_or(INVALID)?;
    }
    Ok(request)
}

/// A `trust` frame body (contract §6 "Trust frames").
pub fn trust_request(
    value: &Value,
) -> Result<trust_request::TrustRequest, trust_reply::RefusedCode> {
    use trust_request::TrustRequest;
    let invalid = trust_reply::RefusedCode::InvalidRequest;
    let request = typed(value).ok_or(INVALID)?;
    paths(
        value,
        &[
            "worktreeRoot",
            "adminDirectory",
            "commonDirectory",
            "gitSelectedPath",
        ],
    )?;
    match &request {
        // typify drops the `policyVersion: 2` constant, the 20-name bound of each `details` kind, the `more` range, and the `unlisted: true`
        // constant of a hooks item (feature 004 contract Δ5 and Δ6, plan D14).
        TrustRequest::Confirm { .. }
            if value["policyVersion"].as_u64() != Some(2)
                || !value["details"].as_object().is_some_and(|kinds| {
                    kinds.values().all(|kind| {
                        kind["names"]
                            .as_array()
                            .is_some_and(|names| names.len() <= TRUST_DIALOG_NAMES)
                            && kind["more"].as_u64().is_some()
                    })
                })
                || value["details"]["hooks"]["names"]
                    .as_array()
                    .is_some_and(|names| {
                        names.iter().any(|name| {
                            name.get("unlisted")
                                .is_some_and(|unlisted| unlisted != &Value::Bool(true))
                        })
                    }) =>
        {
            Err(invalid)
        }
        TrustRequest::ConfirmRun {
            program_count,
            unchecked_count,
            submodule_paths,
            ..
        } => {
            let unchecked = u64::try_from(*unchecked_count).map_err(|_| invalid)?;
            if unchecked > program_count.get()
                || !(1..=SUBMODULE_PATHS).contains(&submodule_paths.len())
            {
                return Err(invalid);
            }
            value["submodulePaths"]
                .as_array()
                .ok_or(invalid)?
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
    let request: WslRequest = typed(value).ok_or(INVALID)?;
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
/// Version 1 has no `policyVersion`. typify drops the `policyVersion: 2` constant of version 2 (feature 004 data-model §10).
pub fn trust_record(value: &Value) -> bool {
    typed::<trust_record::TrustRecord>(value).is_some()
        && value
            .get("policyVersion")
            .is_none_or(|version| version.as_u64() == Some(2))
        && one_identity_form(value)
        && paths(
            value,
            &[
                "commonDirectory",
                "worktreeRoot",
                "gitDirectory",
                "adminDirectory",
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
    typed(value).ok_or(INVALID)
}

/// A progress event with exactly the contract §2 fields and nonnegative counters.
/// Only phase `wsl-starting` carries `distro` (contract §11 "Distro start").
/// Only phases `fetch` and `update` carry `path`, and they always carry it (contract §2).
/// A phase of feature 003 contract Δ2 carries only the counters `percent`, `remoteIndex`, and `remoteCount`.
/// Feature 004 contract Δ2: `stage-files` carries only `fileIndex` and `fileCount`, `config` only `keyIndex` and `keyCount`,
/// and each other feature 004 phase no counter.
pub fn progress(value: &Value) -> bool {
    use progress::ProgressPhase as P;
    typed::<progress::Progress>(value).is_some_and(|event| {
        let allowed: Option<&[&str]> = match event.phase {
            Some(
                P::SyncFetch
                | P::SyncMerge
                | P::SyncRebase
                | P::SyncPush
                | P::SyncContinue
                | P::Clone
                | P::Pageant,
            ) => Some(&SYNC_COUNTERS),
            Some(P::StageFiles | P::DeleteFiles) => Some(&["fileIndex", "fileCount"]),
            // Feature 005 contract Δ2.
            Some(P::Blame) => Some(&["blamed", "total"]),
            Some(P::Config) => Some(&["keyIndex", "keyCount"]),
            Some(
                P::SwitchStash
                | P::SwitchCheckout
                | P::SwitchReapply
                | P::SwitchDrop
                | P::Branch
                | P::Merge
                | P::Rebase
                | P::Resolve
                | P::Mergetool
                | P::Worktree
                | P::Ignore
                | P::IgnoreSave
                | P::Preview,
            ) => Some(&[]),
            _ => None,
        };
        event.counters.values().all(|count| *count >= 0)
            && (event.phase == Some(P::WslStarting)) == event.distro.is_some()
            && matches!(event.phase, Some(P::Fetch | P::Update)) == event.path.is_some()
            && allowed.is_none_or(|allowed| {
                event
                    .counters
                    .keys()
                    .all(|key| allowed.contains(&key.as_str()))
            })
    })
}

/// The `process`, `mutation`, and `trust` refused codes are one contract §6 list. typify gives each schema its own enum.
impl From<process_reply::RefusedCode> for mutation_reply::RefusedCode {
    fn from(code: process_reply::RefusedCode) -> Self {
        use process_reply::RefusedCode as P;
        match code {
            P::InvalidRequest => Self::InvalidRequest,
            P::UnknownTarget => Self::UnknownTarget,
            P::GitChanged => Self::GitChanged,
            P::ProcessOwnershipFailed => Self::ProcessOwnershipFailed,
        }
    }
}

impl From<process_reply::RefusedCode> for trust_reply::RefusedCode {
    fn from(code: process_reply::RefusedCode) -> Self {
        use process_reply::RefusedCode as P;
        match code {
            P::InvalidRequest => Self::InvalidRequest,
            P::UnknownTarget => Self::UnknownTarget,
            P::GitChanged => Self::GitChanged,
            P::ProcessOwnershipFailed => Self::ProcessOwnershipFailed,
        }
    }
}

/// The replies of contract §6 "Process replies", "Recovery markers", and §7 "Trust approval store".
/// typify drops `const` values, so each builder writes them. Each `type` value and each `const` value has one site here.
pub mod reply {
    use std::fmt::Debug;
    use std::str::FromStr;

    use serde::Serialize;
    use serde_json::{Value, json};

    use super::{mutation_reply as m, process_reply as p, trust_reply as t, typed};
    use crate::bootstrap::PhysicalIdentity;
    use crate::file_append::AppendResult;
    use crate::process_requests::{Destination, encode_base64};
    use crate::putty::Unavailable;
    use crate::settings::{hex, sha256};

    const DEADLINE: &str = "deadline";
    const APPROVED: &str = "approved";
    const DECLINED: &str = "declined";

    /// An ID, a path, or a hex text that the shell built inside its schema rule, such as a call ID that passed `is_identifier`.
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

    /// Built without the generated `p::Output` type: its base64 pattern check costs about 1 ms for each 64 KiB chunk.
    /// `encode_base64` writes canonical padded base64, and `call_id` passed `is_identifier`.
    /// A test checks this form against `p::Output`.
    pub fn output(call_id: &str, stream: p::OutputStream, base64: &str) -> Value {
        json!({ "type": "output", "callId": call_id, "stream": stream, "data": base64 })
    }

    pub fn input_written(call_id: &str) -> Value {
        encode(p::ProcessReply::InputWritten {
            call_id: field(call_id),
            type_: "inputWritten".into(),
        })
    }

    /// The stall event of contract §6 "Activity and stall notice".
    pub fn activity(call_id: &str, state: p::ActivityState) -> Value {
        encode(p::ProcessReply::Activity {
            call_id: field(call_id),
            state,
            type_: "activity".into(),
        })
    }

    /// `exit_code` and `active_descendants` `None` encode as `null`.
    pub fn exit(
        call_id: &str,
        exit_code: Option<u32>,
        active_descendants: Option<u32>,
        deadline: Option<p::ExitDeadline>,
    ) -> Value {
        encode(p::ProcessReply::Exit {
            active_descendants: active_descendants.map(Into::into),
            call_id: field(call_id),
            deadline,
            exit_code,
            type_: "exit".into(),
        })
    }

    /// The `refused` reply of a `process` frame.
    pub fn refused(call_id: &str, code: p::RefusedCode) -> Value {
        encode(p::ProcessReply::Refused {
            call_id: field(call_id),
            code,
            type_: "refused".into(),
        })
    }

    pub fn identity(call_id: &str, identities: Vec<p::IdentityListIdentitiesItem>) -> Value {
        encode(p::ProcessReply::IdentityGroup(p::IdentityGroup::List {
            call_id: field(call_id),
            identities,
            type_: "identity".into(),
        }))
    }

    pub fn identity_deadline(call_id: &str) -> Value {
        encode(p::ProcessReply::IdentityGroup(p::IdentityGroup::Deadline {
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
        encode(p::ProcessReply::LingeringCountGroup(
            p::LingeringCountGroup::Reply {
                call_id: field(call_id),
                count: count.into(),
                type_: "lingeringCount".into(),
            },
        ))
    }

    pub fn lingering_count_deadline(call_id: &str) -> Value {
        encode(p::ProcessReply::LingeringCountGroup(
            p::LingeringCountGroup::Deadline {
                call_id: field(call_id),
                deadline: DEADLINE.into(),
                type_: "lingeringCount".into(),
            },
        ))
    }

    pub fn register(call_id: &str, result: p::RegisterResultResult) -> Value {
        encode(p::ProcessReply::RegisterGroup(p::RegisterGroup::Result {
            call_id: field(call_id),
            result,
            type_: "register".into(),
        }))
    }

    /// A new `gitProbe` context for the picked file.
    pub fn register_another(call_id: &str, bootstrap_id: &str, executable_path: &str) -> Value {
        encode(p::ProcessReply::RegisterGroup(p::RegisterGroup::Another {
            bootstrap_id: field(bootstrap_id),
            call_id: field(call_id),
            executable_path: field(executable_path),
            result: "another".into(),
            type_: "register".into(),
        }))
    }

    pub fn register_deadline(call_id: &str) -> Value {
        encode(p::ProcessReply::RegisterGroup(p::RegisterGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "register".into(),
        }))
    }

    pub fn resolve_git(call_id: &str, bootstrap_id: &str) -> Value {
        encode(p::ProcessReply::ResolveGitGroup(
            p::ResolveGitGroup::Reply {
                bootstrap_id: field(bootstrap_id),
                call_id: field(call_id),
                type_: "resolveGit".into(),
            },
        ))
    }

    pub fn resolve_git_deadline(call_id: &str) -> Value {
        encode(p::ProcessReply::ResolveGitGroup(
            p::ResolveGitGroup::Deadline {
                call_id: field(call_id),
                deadline: DEADLINE.into(),
                type_: "resolveGit".into(),
            },
        ))
    }

    /// `index` only for a WSL request with `index` (contract §6 "Index digest in a read").
    pub fn file_facts(
        call_id: &str,
        facts: Vec<p::FileFactsReplyFactsItem>,
        index: Option<p::WslIndexResult>,
    ) -> Value {
        encode(p::ProcessReply::FileFactsGroup(p::FileFactsGroup::Reply {
            call_id: field(call_id),
            facts,
            index,
            type_: "fileFacts".into(),
        }))
    }

    pub fn file_facts_deadline(call_id: &str) -> Value {
        encode(p::ProcessReply::FileFactsGroup(
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

    // ---- `wslFiles` (contract §6 "WSL file work") ----

    pub fn wsl_files(call_id: &str, results: Vec<p::WslFilesResultsResultsItem>) -> Value {
        encode(p::ProcessReply::WslFilesReplyGroup(
            p::WslFilesReplyGroup::Results {
                call_id: field(call_id),
                results,
                type_: "wslFiles".into(),
            },
        ))
    }

    pub fn wsl_files_deadline(call_id: &str) -> Value {
        encode(p::ProcessReply::WslFilesReplyGroup(
            p::WslFilesReplyGroup::Deadline {
                call_id: field(call_id),
                deadline: DEADLINE.into(),
                type_: "wslFiles".into(),
            },
        ))
    }

    /// `code` is one of the POSIX codes of contract §6 "File facts".
    pub fn wsl_error(component: usize, code: &str) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::Error {
            code: field(code),
            component: count(component),
        }
    }

    /// A link at `component`. Only a final link holds its raw target and the SHA-256 of it.
    pub fn wsl_link(component: usize, target: Option<&[u8]>) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::Link {
            component: count(component),
            sha256: target.map(|bytes| field(&hex(&sha256(bytes)))),
            target_bytes: target.map(|bytes| field(&encode_base64(bytes))),
        }
    }

    /// A `digest` file: its SHA-256, or the bound name above the bound.
    pub fn wsl_file(
        size: i64,
        changed: bool,
        digest: Result<&str, &str>,
    ) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::File {
            bound: digest.err().map(field),
            changed,
            sha256: digest.ok().map(field),
            size,
        }
    }

    pub fn wsl_object(
        size: i64,
        sha256: &str,
        oid: Option<&str>,
        git_exit: p::WslExit,
        hash_exit: p::WslExit,
    ) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::Object {
            git_exit,
            hash_exit,
            oid: oid.map(field),
            sha256: field(sha256),
            size,
        }
    }

    pub fn wsl_blob(
        size: i64,
        sha256: &str,
        over: bool,
        git_exit: p::WslExit,
        hash_exit: p::WslExit,
    ) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::Blob {
            git_exit,
            hash_exit,
            over,
            sha256: field(sha256),
            size,
        }
    }

    pub fn wsl_lock(device: u64, inode: u64) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::Lock {
            device: field(&device.to_string()),
            inode: field(&inode.to_string()),
        }
    }

    /// The index and the candidate: each its size, SHA-256, and `st_mtime` in whole seconds.
    pub fn wsl_candidate(
        index: (i64, String, i64),
        candidate: (i64, String, i64),
    ) -> p::WslFilesResultsResultsItem {
        let copy = |(size, sha256, mtime): (i64, String, i64)| p::WslCopy {
            mtime: field(&mtime.to_string()),
            sha256: field(&sha256),
            size,
        };
        p::WslFilesResultsResultsItem::Candidate {
            candidate: copy(candidate),
            index: copy(index),
        }
    }

    pub fn wsl_published(size: i64, sha256: &str) -> p::WslFilesResultsResultsItem {
        p::WslFilesResultsResultsItem::Published {
            sha256: field(sha256),
            size,
        }
    }

    pub fn index_digest(size: i64, sha256: &str) -> p::WslIndexPart {
        p::WslIndexPart::Digest {
            sha256: field(sha256),
            size,
        }
    }

    pub fn index_error(code: &str) -> p::WslIndexPart {
        p::WslIndexPart::Error { code: field(code) }
    }

    /// The `index` of a failed probe.
    pub fn index_failed(component: usize, code: &str) -> p::WslIndexResult {
        p::WslIndexResult::Error {
            code: field(code),
            component: count(component),
        }
    }

    /// The reply holds the context path alone for a path without a WSL prefix.
    /// Feature 003 contract Δ6 `destinationFacts`. Feature 004 contract Δ6: the reply to the `worktreeAdd` form adds
    /// `path`, the bound path in Git's form for the route.
    pub fn destination_facts(call_id: &str, facts: Destination, path: Option<&str>) -> Value {
        use p::DestinationFactsResultResult as R;
        let result = match facts {
            Destination::Absent => Ok(R::Absent),
            Destination::Empty => Ok(R::Empty),
            Destination::NotEmpty => Ok(R::NotEmpty),
            Destination::File => Ok(R::File),
            Destination::Other => Ok(R::Other),
            Destination::Error(code) => Err(code),
        };
        let mut reply = encode(p::ProcessReply::DestinationFactsGroup(match result {
            Ok(result) => p::DestinationFactsGroup::Result {
                call_id: field(call_id),
                result,
                type_: "destinationFacts".into(),
            },
            Err(code) => p::DestinationFactsGroup::Error {
                call_id: field(call_id),
                code: field(code),
                result: "error".into(),
                type_: "destinationFacts".into(),
            },
        }));
        if let Some(path) = path {
            reply["path"] = json!(path);
        }
        reply
    }

    /// Feature 003 contract Δ6 `pageant`: `git`, `none`, or `ready`.
    pub fn pageant(call_id: &str, result: p::PageantResultResult) -> Value {
        encode(p::ProcessReply::PageantReplyGroup(
            p::PageantReplyGroup::Result {
                call_id: field(call_id),
                result,
                type_: "pageant".into(),
            },
        ))
    }

    /// Feature 003 contract Δ6 `pageant` with contract Δ9 `PUTTY_UNAVAILABLE`.
    pub fn pageant_failed(call_id: &str, failed: &Unavailable) -> Value {
        encode(p::ProcessReply::PageantReplyGroup(
            p::PageantReplyGroup::Failed {
                call_id: field(call_id),
                path: field(&failed.path.to_string_lossy()),
                program: field(failed.program.name()),
                reason: field(failed.reason.name()),
                result: "failed".into(),
                type_: "pageant".into(),
            },
        ))
    }

    /// Feature 004 contract Δ6 `fileAppend`: `appended`, `stale`, `stopped`, `interrupted`, `refused` with `not-regular`, or `error` with a file fact code.
    pub fn file_append(call_id: &str, appended: AppendResult) -> Value {
        use p::FileAppendGroup as G;
        use p::FileAppendResultResult as R;
        let type_ = "fileAppend".to_string();
        let result = |result: R| G::Result {
            call_id: field(call_id),
            result,
            type_: type_.clone(),
        };
        encode(p::ProcessReply::FileAppendGroup(match appended {
            AppendResult::Appended => result(R::Appended),
            AppendResult::Stale => result(R::Stale),
            AppendResult::Stopped => result(R::Stopped),
            AppendResult::Interrupted => result(R::Interrupted),
            AppendResult::NotRegular => G::Refused {
                call_id: field(call_id),
                reason: p::FileAppendRefusedReason::NotRegular,
                result: "refused".into(),
                type_,
            },
            AppendResult::Error(code) => G::Error {
                call_id: field(call_id),
                code,
                result: "error".into(),
                type_,
            },
        }))
    }

    /// Feature 005 contract Δ6 `fileDelete`: one result per entry and per folder, in request order.
    pub fn file_delete(
        call_id: &str,
        entries: &[crate::file_delete::EntryResult],
        folders: &[crate::file_delete::FolderResult],
    ) -> Value {
        use crate::file_delete::{EntryResult as E, FolderResult as F};
        use p::DeleteEntryResultResult as R;
        use p::DeleteFolderResultResult as D;
        use p::{FileDeleteReplyEntriesItem as Entry, FileDeleteReplyFoldersItem as Folder};
        let entries = entries
            .iter()
            .map(|entry| match entry {
                E::Deleted => Entry::Result { result: R::Deleted },
                E::Stale => Entry::Result { result: R::Stale },
                E::Absent => Entry::Result { result: R::Absent },
                E::NotRegular => Entry::Result {
                    result: R::NotRegular,
                },
                E::Stopped => Entry::Result { result: R::Stopped },
                E::Recycled(path) => Entry::Recycled {
                    recycled_path: field(path),
                    result: "recycled".to_string(),
                },
                E::Kept(hresult) => Entry::Kept {
                    hresult: *hresult,
                    result: "kept".to_string(),
                },
                E::Error(code) => Entry::Error {
                    code: field(&code.to_string()),
                    result: "error".to_string(),
                },
            })
            .collect();
        let folders = folders
            .iter()
            .map(|folder| match folder {
                F::Removed => Folder::Result { result: D::Removed },
                F::Kept => Folder::Result { result: D::Kept },
                F::Absent => Folder::Result { result: D::Absent },
                F::NotRegular => Folder::Result {
                    result: D::NotRegular,
                },
                F::Error(code) => Folder::Error {
                    code: field(&code.to_string()),
                    result: "error".to_string(),
                },
            })
            .collect();
        encode(p::ProcessReply::FileDeleteReply {
            call_id: field(call_id),
            entries,
            folders,
            type_: "fileDelete".to_string(),
        })
    }

    /// Feature 005 contract Δ6: a `fileDelete` walk that stopped or passed its deadline before the delete deleted nothing.
    pub fn file_delete_empty(call_id: &str) -> Value {
        encode(p::ProcessReply::FileDeleteReply {
            call_id: field(call_id),
            entries: Vec::new(),
            folders: Vec::new(),
            type_: "fileDelete".to_string(),
        })
    }

    /// Feature 005 contract Δ6 `fileReplace`: `replaced`, `stale`, `stopped`, `interrupted`, `refused not-regular`, or `error`.
    pub fn file_replace(call_id: &str, result: crate::file_replace::ReplaceResult) -> Value {
        use crate::file_replace::ReplaceResult as V;
        use p::FileReplaceGroup as G;
        use p::FileReplaceResultResult as R;
        let type_ = "fileReplace".to_string();
        let plain = |result: R| G::Result {
            call_id: field(call_id),
            result,
            type_: type_.clone(),
        };
        encode(p::ProcessReply::FileReplaceGroup(match result {
            V::Replaced => plain(R::Replaced),
            V::Stale => plain(R::Stale),
            V::Stopped => plain(R::Stopped),
            V::Interrupted => plain(R::Interrupted),
            V::NotRegular => G::Refused {
                call_id: field(call_id),
                reason: p::FileReplaceRefusedReason::NotRegular,
                result: "refused".to_string(),
                type_,
            },
            V::Error(code) => G::Error {
                call_id: field(call_id),
                code: field(&code.to_string()),
                result: "error".to_string(),
                type_,
            },
        }))
    }

    /// Feature 005 contract Δ6: a `fileReplace` walk past its deadline writes nothing, so it gives `error other-error`.
    pub fn file_replace_deadline(call_id: &str) -> Value {
        file_replace(call_id, crate::file_replace::ReplaceResult::Error(p::FileFactErrorCode::OtherError))
    }

    /// Feature 005 contract Δ6: a stop of a Windows `fileReplace` walk before the write.
    pub fn file_replace_stopped(call_id: &str) -> Value {
        file_replace(call_id, crate::file_replace::ReplaceResult::Stopped)
    }

    /// Feature 005 contract Δ6: a stop of a WSL `fileReplace` walk that could have written.
    pub fn file_replace_interrupted(call_id: &str) -> Value {
        file_replace(call_id, crate::file_replace::ReplaceResult::Interrupted)
    }

    /// Feature 005 contract Δ6 `shadow`: the bound shadow folder of one preview operation.
    pub fn shadow(call_id: &str, shadow_id: &str) -> Value {
        encode(p::ProcessReply::ShadowGroup(p::ShadowGroup::Created {
            call_id: field(call_id),
            shadow_id: field(shadow_id),
            type_: "shadow".to_string(),
        }))
    }

    /// Feature 005 contract Δ6 `shadow`: a failed create.
    pub fn shadow_error(call_id: &str, code: p::FileFactErrorCode) -> Value {
        encode(p::ProcessReply::ShadowGroup(p::ShadowGroup::Error {
            call_id: field(call_id),
            code: field(&code.to_string()),
            result: "error".to_string(),
            type_: "shadow".to_string(),
        }))
    }

    /// Feature 005 contract Δ6: the `reveal` walk found no entry. The service maps it to `UNKNOWN_TARGET` reason `absent`.
    pub fn reveal_absent(call_id: &str) -> Value {
        encode(p::ProcessReply::RevealAbsent {
            call_id: field(call_id),
            result: p::RevealAbsentResult::Absent,
            type_: "reveal".to_string(),
        })
    }

    /// Feature 004 contract Δ3 `revealPath`: Explorer shows the path.
    pub fn reveal(call_id: &str) -> Value {
        encode(p::ProcessReply::RevealReply {
            call_id: field(call_id),
            type_: "reveal".into(),
        })
    }

    /// Feature 003 contract Δ6 `terminal`: the console started.
    pub fn terminal_started(call_id: &str) -> Value {
        encode(p::ProcessReply::TerminalGroup(p::TerminalGroup::Started {
            call_id: field(call_id),
            type_: "terminal".into(),
        }))
    }

    /// Feature 003 contract Δ6 `terminal` with contract Δ9 `PUTTY_UNAVAILABLE`. typify tags this group by `result`.
    pub fn terminal_failed(call_id: &str, failed: &Unavailable) -> Value {
        encode(p::ProcessReply::TerminalGroup(p::TerminalGroup::Failed {
            call_id: field(call_id),
            path: field(&failed.path.to_string_lossy()),
            program: field(failed.program.name()),
            reason: field(failed.reason.name()),
            type_: "terminal".into(),
        }))
    }

    pub fn wsl_distros_path(call_id: &str, path: &str) -> Value {
        encode(p::ProcessReply::WslDistrosGroup(p::WslDistrosGroup::Path {
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
        encode(p::ProcessReply::WslDistrosGroup(
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
        encode(p::ProcessReply::WslDistrosGroup(
            p::WslDistrosGroup::Unavailable {
                call_id: field(call_id),
                code: "WSL_UNAVAILABLE".into(),
                path: field(path),
                reason: "wsl-missing".into(),
                type_: "wslDistros".into(),
            },
        ))
    }

    pub fn started_marker(call_id: &str, marker_id: &str) -> Value {
        encode(m::MutationReply::StartedGroup(m::StartedGroup::Marker {
            call_id: field(call_id),
            marker_id: field(marker_id),
            type_: "started".into(),
        }))
    }

    pub fn started_busy(call_id: &str) -> Value {
        encode(m::MutationReply::StartedGroup(m::StartedGroup::Busy {
            busy: true,
            call_id: field(call_id),
            type_: "started".into(),
        }))
    }

    /// `folder` is the `recovery` folder.
    pub fn started_failure(
        call_id: &str,
        failure: m::StartedFailureFailure,
        folder: &str,
    ) -> Value {
        encode(m::MutationReply::StartedGroup(m::StartedGroup::Failure {
            call_id: field(call_id),
            failure,
            folder: field(folder),
            type_: "started".into(),
        }))
    }

    pub fn started_deadline(call_id: &str) -> Value {
        encode(m::MutationReply::StartedGroup(m::StartedGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "started".into(),
        }))
    }

    pub fn mutation_refused(call_id: &str, code: m::RefusedCode) -> Value {
        encode(m::MutationReply::Refused {
            call_id: field(call_id),
            code,
            type_: "refused".into(),
        })
    }

    pub fn confirm_declined(call_id: &str) -> Value {
        encode(t::TrustReply::ConfirmGroup(t::ConfirmGroup::Declined {
            call_id: field(call_id),
            result: DECLINED.into(),
            type_: "confirm".into(),
        }))
    }

    /// `stored: false`: the approval holds for the session only.
    pub fn confirm_session(call_id: &str) -> Value {
        encode(t::TrustReply::ConfirmGroup(t::ConfirmGroup::Session {
            call_id: field(call_id),
            result: APPROVED.into(),
            stored: false,
            type_: "confirm".into(),
        }))
    }

    /// `record` passed `schema::trust_record` before the store wrote it.
    /// The reply carries the stored form, because typify encodes the `policyVersion` constant as a float.
    pub fn confirm_stored(call_id: &str, record: &Value) -> Value {
        let mut built = encode(t::TrustReply::ConfirmGroup(t::ConfirmGroup::Stored {
            call_id: field(call_id),
            record: typed(record).expect("a stored trust record passed its schema check"),
            result: APPROVED.into(),
            stored: true,
            type_: "confirm".into(),
        }));
        built["record"] = record.clone();
        built
    }

    pub fn confirm_run(call_id: &str, result: t::ConfirmRunReplyResult) -> Value {
        encode(t::TrustReply::ConfirmRunReply {
            call_id: field(call_id),
            result,
            type_: "confirmRun".into(),
        })
    }

    pub fn revoke(call_id: &str, ended_processes: u32) -> Value {
        encode(t::TrustReply::RevokeGroup(t::RevokeGroup::Reply {
            call_id: field(call_id),
            ended_processes: ended_processes.into(),
            type_: "revoke".into(),
        }))
    }

    pub fn revoke_deadline(call_id: &str) -> Value {
        encode(t::TrustReply::RevokeGroup(t::RevokeGroup::Deadline {
            call_id: field(call_id),
            deadline: DEADLINE.into(),
            type_: "revoke".into(),
        }))
    }

    pub fn trust_refused(call_id: &str, code: t::RefusedCode) -> Value {
        encode(t::TrustReply::Refused {
            call_id: field(call_id),
            code,
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
    /// The shell forwards the registration, trust, workspace, entries, history, reference, operation, sync review, sync, clone, branch, worktree, Git settings, and workbench results in `Response.result` and reads no field of them.
    /// The shell writes the settings result of the shell-only settings operations and never reads it.
    /// The same holds for the `chooseWorktreeFolder` result.
    const NOT_READ: [&str; 39] = [
        "service-envelope",
        "open-recent-repository-result",
        "recent-repositories-result",
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
        "open-history-result",
        "load-history-result",
        "read-history-rows-result",
        "search-history-result",
        "read-refs-result",
        "read-comparison-result",
        "operation-result",
        "review-sync-result",
        "sync-settings-result",
        "sync-result",
        "clone-result",
        // Feature 004 contract Δ10.
        "read-branches-result",
        "read-worktrees-result",
        "read-git-settings-result",
        "review-workbench-result",
        "run-workbench-result",
        "choose-worktree-folder-result",
        "review-commit-result",
        // Feature 005 contract Δ10.
        "read-commit-changes-result",
        "read-commit-file-result",
        "read-blame-result",
        "read-ignore-file-result",
        "preview-ignore-result",
        "open-submodule-result",
        "reveal-path-result",
    ];

    /// The result of the shell code path for one vector. `None`: the shell reads no value of that schema.
    fn check(schema: &str, text: &str) -> Option<String> {
        let ok = |checked: Result<(), String>| {
            checked.map_or_else(|code| code, |()| "valid".to_string())
        };
        let text_of = |code: &dyn std::fmt::Display| code.to_string();
        let strict = |text: &str| decode_strict(text).ok_or(INVALID.to_string());
        let valid = |valid: bool| {
            if valid {
                Ok(())
            } else {
                Err(INVALID.to_string())
            }
        };
        Some(ok(match schema {
            "native-first-envelope" => strict(text).and_then(|value| {
                native_first(&value)
                    .map(drop)
                    .map_err(|code| text_of(&code))
            }),
            "mutation-request" => strict(text).and_then(|value| {
                mutation_request(&value)
                    .map(drop)
                    .map_err(|code| text_of(&code))
            }),
            "trust-request" => strict(text).and_then(|value| {
                trust_request(&value)
                    .map(drop)
                    .map_err(|code| text_of(&code))
            }),
            "trust-record" => strict(text).and_then(|value| valid(trust_record(&value))),
            "handshake" => strict(text)
                .and_then(|value| handshake(&value).map(drop).map_err(|code| text_of(&code))),
            "progress" => strict(text).and_then(|value| valid(progress(&value))),
            "wsl-request" => strict(text)
                .and_then(|value| wsl_request(&value).map(drop).map_err(|code| text_of(&code))),
            // `ProcessRequests::dispatch` reads the `type` value, then its generated type (contract §6 "Channel frames").
            // Feature 003 contract Δ10: the `run`, `pageant`, `destinationFacts`, and `terminal` vectors check the generated type.
            // T030 and T031 add the handlers of the `clone` context and the new requests.
            "process-request" => match strict(text) {
                Ok(value)
                    if matches!(
                        value["type"].as_str(),
                        Some("run" | "pageant" | "destinationFacts" | "terminal" | "shadow")
                    ) =>
                {
                    valid(typed::<process_request::ProcessRequest>(&value).is_some())
                }
                // Feature 005 contract Δ6: the field rules of `file_delete::parse` and `file_replace::parse`.
                Ok(value) if value["type"] == "fileDelete" => typed(&value)
                    .ok_or(INVALID)
                    .and_then(|request| crate::file_delete::parse(&request).map(drop))
                    .map_err(|code| text_of(&code)),
                Ok(value) if value["type"] == "fileReplace" => typed(&value)
                    .ok_or(INVALID)
                    .and_then(|request| crate::file_replace::parse(&request).map(drop))
                    .map_err(|code| text_of(&code)),
                Ok(value) if value["type"] == "fileFacts" => typed(&value)
                    .ok_or(INVALID)
                    .and_then(|request| crate::file_facts::parse(&request).map(drop))
                    .map_err(|code| text_of(&code)),
                Ok(value) if value["type"] == "wslFiles" => typed(&value)
                    .ok_or(INVALID)
                    .and_then(|request| {
                        crate::file_facts::wsl_files_request(&value, &request).map(drop)
                    })
                    .map_err(|code| text_of(&code)),
                // Feature 004 contract Δ6: the field rules of `ProcessRequests::dispatch` for `fileAppend` and `reveal`.
                Ok(value) if value["type"] == "fileAppend" => typed(&value)
                    .ok_or(INVALID)
                    .and_then(|request| crate::file_append::parse(&request).map(drop))
                    .map_err(|code| text_of(&code)),
                Ok(value) if value["type"] == "reveal" => typed::<process_request::Reveal>(&value)
                    .ok_or(INVALID)
                    .and_then(|request| path(&json!(request.path.as_str())).map(drop))
                    .map_err(|code| text_of(&code)),
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
        // Feature 004 T017 adds 25 vectors, and `fileAppend` and `reveal` add 3 (contract Δ10).
        // T057 replaces 5 `confirm` vectors with 8 version 2 vectors and adds 4 version 2 record vectors (contract Δ6).
        // The `unlisted` hooks item of plan D14 adds 2 `confirm` vectors.
        // WP23 adds 2 `confirm` vectors for the `repository` action (contract Δ6).
        // T094 adds 3 `native-first-envelope` vectors for `chooseWorktreeFolder` (contract Δ3).
        // Feature 005 T002 adds 15 shell-read vectors. The batch 0 review adds the 5 `fileDelete`, 2 `shadow`, and 3 `ignorePreview` vectors.
        // T013 adds the 4 `fileReplace` vectors (valid present and absent, an over-bound size, and a relative path).
        assert_eq!(
            checked,
            if cfg!(windows) { 209 } else { 204 },
            "shell-read vectors"
        );
    }

    /// Each reply builder of `reply` against the wire form of its variant: a golden vector where one exists, else the contract §6 or §7 form.
    #[test]
    fn each_reply_builder_gives_the_wire_form_of_its_variant() {
        use process_reply::{
            ActivityState, ExitDeadline, FileFactErrorCode, FileFactLinkTag,
            FileFactsReplyFactsItem as Fact, IdentityRefusedReason, OutputStream,
            RegisterResultResult, WslExit, WslFilesResultsResultsItem as WslFile,
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
            "policyVersion": 2,
            "commonDirectory": "C:\\repo\\.git",
            "commonIdentity": windows.reply(),
            "worktreeRoot": "C:\\repo",
            "adminDirectory": "C:\\repo\\.git",
            "worktreeIdentity": [windows.reply(), windows.reply()],
            "gitSelectedPath": "C:\\Git\\cmd\\git.exe",
            "approvedAt": "2026-10-07T10:00:00Z",
        });
        assert!(trust_record(&record), "{record}");
        let facts = vec![
            Fact::File {
                bound: None,
                bytes: None,
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
                    Some(0),
                    None,
                ),
                vector("process-exit-largest-code.json"),
            ),
            (
                reply::exit(call, None, Some(2), Some(ExitDeadline::Deadline)),
                json!({ "type": "exit", "callId": call, "exitCode": null, "activeDescendants": 2, "deadline": "deadline" }),
            ),
            (
                reply::exit(call, None, Some(0), Some(ExitDeadline::Inactivity)),
                json!({ "type": "exit", "callId": call, "exitCode": null, "activeDescendants": 0, "deadline": "inactivity" }),
            ),
            (
                reply::exit(call, Some(0), None, None),
                json!({ "type": "exit", "callId": call, "exitCode": 0, "activeDescendants": null }),
            ),
            (
                reply::activity(call, ActivityState::Stalled),
                json!({ "type": "activity", "callId": call, "state": "stalled" }),
            ),
            (
                reply::activity(call, ActivityState::Active),
                json!({ "type": "activity", "callId": call, "state": "active" }),
            ),
            (
                reply::refused(call, Code::GitChanged),
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
                reply::file_facts(call, facts, None),
                vector("file-facts-reply.json"),
            ),
            (
                reply::file_facts(
                    "0f0f0f0f-0000-4000-8000-000000000001",
                    vec![Fact::Absent],
                    Some(process_reply::WslIndexResult::Index {
                        index: reply::index_digest(104, &"a".repeat(64)),
                        shared_index: Some(process_reply::WslIndexPart::Bound),
                    }),
                ),
                vector("file-facts-reply-index.json"),
            ),
            (
                reply::wsl_files(
                    call,
                    vec![
                        reply::wsl_file(3, false, Ok(&"a".repeat(64))),
                        reply::wsl_file(1_048_577, true, Err("COMPARED_RAW_VERSION_BYTES")),
                        reply::wsl_link(1, Some(&[0xff])),
                        reply::wsl_link(1, None),
                        WslFile::Directory,
                        WslFile::Absent,
                        WslFile::Other,
                        reply::wsl_error(2, "access-denied"),
                    ],
                ),
                vector("wsl-files-reply.json"),
            ),
            (
                reply::wsl_files(
                    call,
                    vec![
                        WslFile::Index {
                            index: reply::index_digest(104, &"a".repeat(64)),
                            shared_index: Some(process_reply::WslIndexPart::Absent),
                        },
                        reply::wsl_object(
                            12,
                            &"a".repeat(64),
                            Some(&"b".repeat(40)),
                            WslExit::ExitCode(0),
                            WslExit::ExitCode(0),
                        ),
                        reply::wsl_blob(
                            1,
                            &"a".repeat(64),
                            true,
                            WslExit::Signal(std::num::NonZeroU64::new(13).expect("13")),
                            WslExit::ExitCode(0),
                        ),
                        reply::wsl_lock(2112, 57001),
                        WslFile::Locked,
                        reply::wsl_candidate(
                            (104, "a".repeat(64), 1_791_410_531),
                            (104, "a".repeat(64), 1_791_410_531),
                        ),
                        WslFile::Bound,
                        reply::wsl_published(104, &"a".repeat(64)),
                        WslFile::Mismatch,
                        WslFile::NotOwned,
                        WslFile::Removed,
                    ],
                ),
                vector("wsl-files-reply-modes.json"),
            ),
            (
                reply::wsl_files_deadline(call),
                vector("wsl-files-reply-deadline.json"),
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
                reply::started_failure(
                    call,
                    mutation_reply::StartedFailureFailure::DiskFull,
                    "C:\\data\\recovery",
                ),
                json!({ "type": "started", "callId": call, "failure": "disk-full", "folder": "C:\\data\\recovery" }),
            ),
            (
                reply::started_deadline(call),
                vector("started-reply-deadline.json"),
            ),
            (
                reply::mutation_refused(call, mutation_reply::RefusedCode::InvalidRequest),
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
                reply::trust_refused(call, trust_reply::RefusedCode::ProcessOwnershipFailed),
                json!({ "type": "refused", "callId": call, "code": "PROCESS_OWNERSHIP_FAILED" }),
            ),
        ];
        // `reply::output` builds its form by hand, so the generated `Output` type checks it here.
        for data in ["YWJj", "YQ==", "YWI="] {
            let built = reply::output(call, OutputStream::Stdout, data);
            assert!(typed::<process_reply::Output>(&built).is_some(), "{built}");
        }
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
        assert!(typed::<process_reply::IdentityGroup>(&deadline).is_some());
        // Feature 003 contract Δ6: the `pageant` reply `git`. T030 builds it and checks the builder against this vector.
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/vectors/valid/process-reply-pageant-git.json");
        let vector: Vector =
            serde_json::from_str(&std::fs::read_to_string(path).expect("vector file"))
                .expect("vector form");
        let git: Value = serde_json::from_str(&vector.text).expect("vector text");
        assert!(
            typed::<process_reply::ProcessReply>(&git).is_some(),
            "{git}"
        );
        let mut other = git.clone();
        other["result"] = json!("plink");
        assert!(typed::<process_reply::ProcessReply>(&other).is_none());
    }

    /// Feature 003 contract Δ2, Δ3, and Δ6: the rules that the JSON Schema files cannot hold (001 §1).
    #[test]
    fn the_feature_003_rules_outside_json_schema_are_checked_in_rust() {
        let envelope = |operation: &str, payload: Value| json!({ "version": 1, "sessionId": "0f0f0f0f-0000-4000-8000-0000000000aa", "requestId": "0f0f0f0f-0000-4000-8000-000000000001", "operation": operation, "payload": payload });
        let fits =
            |operation: &str, payload: Value| native_first(&envelope(operation, payload)).is_ok();

        // `clone`: 1 to 4,096 UTF-8 bytes, no control character (Unicode category Cc), and a channel path.
        let url = |bytes: usize| {
            let head = "https://example.test/";
            let wide = (bytes - head.len()) / 2;
            format!(
                "{head}{}{}",
                "\u{e9}".repeat(wide),
                "a".repeat(bytes - head.len() - 2 * wide)
            )
        };
        assert_eq!(url(4096).len(), 4096);
        assert!(
            url(4097).chars().count() < 4096,
            "within the character count of typify"
        );
        let clone = |url: &str, destination: &str| json!({ "url": url, "destination": destination, "keyFile": "picked" });
        assert!(fits("clone", clone(&url(4096), "//host/src/tool")));
        for (name, payload) in [
            ("4,097 bytes", clone(&url(4097), "//host/src/tool")),
            ("empty", clone("", "//host/src/tool")),
            ("LF", clone("https://example.test/a\nb", "//host/src/tool")),
            (
                "DEL",
                clone("https://example.test/a\u{7f}", "//host/src/tool"),
            ),
            (
                "NEL",
                clone("https://example.test/a\u{85}", "//host/src/tool"),
            ),
            (
                "a relative destination",
                clone("https://example.test/a", "src\\tool"),
            ),
        ] {
            assert!(!fits("clone", payload), "{name}");
        }

        // `chooseSyncPath` and `clearSyncPath`: `worktreeKey` and `remote` exactly when `target` is `remoteKey`.
        let key = "a".repeat(64);
        for operation in ["chooseSyncPath", "clearSyncPath"] {
            for payload in [
                json!({ "target": "plink" }),
                json!({ "target": "cloneFolder" }),
                json!({ "target": "remoteKey", "worktreeKey": key, "remote": "origin" }),
            ] {
                assert!(fits(operation, payload.clone()), "{operation} {payload}");
            }
            for payload in [
                json!({ "target": "remoteKey" }),
                json!({ "target": "remoteKey", "worktreeKey": key }),
                json!({ "target": "remoteKey", "remote": "origin" }),
                json!({ "target": "plink", "worktreeKey": key }),
                json!({ "target": "cloneFolder", "remote": "origin" }),
                json!({ "target": "plink", "worktreeKey": key, "remote": "origin" }),
            ] {
                assert!(!fits(operation, payload.clone()), "{operation} {payload}");
            }
        }

        // A progress event of a sync phase holds no counter other than `percent`, `remoteIndex`, and `remoteCount`.
        let event = |phase: &str, counters: Value| json!({ "requestId": "0f0f0f0f-0000-4000-8000-000000000001", "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "state": "running", "phase": phase, "counters": counters, "stalled": false });
        for phase in [
            "sync-fetch",
            "sync-merge",
            "sync-rebase",
            "sync-push",
            "sync-continue",
            "clone",
            "pageant",
        ] {
            assert!(progress(&event(phase, json!({}))), "{phase}");
            assert!(
                progress(&event(
                    phase,
                    json!({ "percent": 40, "remoteIndex": 1, "remoteCount": 2 })
                )),
                "{phase}"
            );
            for other in ["objects", "index", "Percent"] {
                assert!(
                    !progress(&event(phase, json!({ other: 1 }))),
                    "{phase} {other}"
                );
            }
        }
        assert!(progress(&event("history-load", json!({ "objects": 1 }))));

        // `direction` `resolve` only with kind `applyFile`. `action` only and always with kind `sync`.
        let started = |fields: Value| {
            let mut frame = json!({ "type": "started", "callId": "0f0f0f0f-0000-4000-8000-000000000003", "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005", "worktreeRoot": "//host/repo", "commonDirectory": "//host/repo/.git" });
            frame
                .as_object_mut()
                .expect("object")
                .extend(fields.as_object().expect("fields").clone());
            mutation_request(&frame).is_ok()
        };
        for action in [
            "fetch",
            "fetch-all",
            "pull",
            "integrate",
            "push",
            "force-push",
            "abort",
            "continue",
            "skip",
        ] {
            assert!(
                started(json!({ "kind": "sync", "action": action })),
                "{action}"
            );
            assert!(
                !started(json!({ "kind": "sync", "action": action, "direction": "stage" })),
                "{action}"
            );
            assert!(
                !started(json!({ "kind": "commit", "action": action })),
                "{action}"
            );
            assert!(
                !started(json!({ "kind": "applyFile", "direction": "resolve", "action": action })),
                "{action}"
            );
        }
        assert!(started(
            json!({ "kind": "applyFile", "direction": "resolve" })
        ));
        for fields in [
            json!({ "kind": "sync" }),
            json!({ "kind": "sync", "direction": "resolve" }),
            json!({ "kind": "applyHunk", "direction": "resolve" }),
            json!({ "kind": "updateSubmodules", "direction": "resolve" }),
            json!({ "kind": "updateSubmodules", "action": "fetch" }),
        ] {
            assert!(!started(fields.clone()), "{fields}");
        }
    }

    /// Feature 004 contract Δ1, Δ2, and Δ6: the rules that the JSON Schema files cannot hold (001 §1).
    #[test]
    fn the_feature_004_rules_outside_json_schema_are_checked_in_rust() {
        let envelope = |operation: &str, payload: Value| json!({ "version": 1, "sessionId": "0f0f0f0f-0000-4000-8000-0000000000aa", "requestId": "0f0f0f0f-0000-4000-8000-000000000001", "operation": operation, "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005", "repositoryGeneration": 3, "payload": payload });
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let add = |branch: Value, path: &str| {
            native_first(&envelope(
                "reviewWorkbench",
                json!({ "action": "worktree-add", "branch": branch, "path": path }),
            ))
            .is_ok()
        };
        // The `worktree-add` path takes the path rule, a new branch 1 to 255 UTF-8 bytes, and an existing branch a name under `refs/heads/`.
        assert!(add(
            json!({ "existing": "refs/heads/topic" }),
            "C:\\src\\wt"
        ));
        assert!(add(
            json!({ "existing": "refs/heads/a/b" }),
            "//host/src/wt"
        ));
        assert!(add(
            json!({ "new": "a".repeat(255), "start": oid }),
            "C:\\src\\wt"
        ));
        assert!(add(
            json!({ "new": "\u{e9}".repeat(127), "start": oid }),
            "C:\\src\\wt"
        ));
        for (name, branch, path) in [
            (
                "a relative path",
                json!({ "existing": "refs/heads/topic" }),
                "src\\wt",
            ),
            (
                "a device path",
                json!({ "existing": "refs/heads/topic" }),
                "\\\\.\\pipe\\x",
            ),
            (
                "an empty path",
                json!({ "existing": "refs/heads/topic" }),
                "",
            ),
            (
                "256 bytes",
                json!({ "new": "\u{e9}".repeat(128), "start": oid }),
                "C:\\src\\wt",
            ),
            (
                "an empty name",
                json!({ "new": "", "start": oid }),
                "C:\\src\\wt",
            ),
            (
                "a tag",
                json!({ "existing": "refs/tags/v1" }),
                "C:\\src\\wt",
            ),
            (
                "the prefix alone",
                json!({ "existing": "refs/heads/" }),
                "C:\\src\\wt",
            ),
            (
                "a short name",
                json!({ "existing": "topic" }),
                "C:\\src\\wt",
            ),
        ] {
            assert!(!add(branch, path), "{name}");
        }
        // typify drops the `action` const of the native-first review.
        let other = envelope(
            "reviewWorkbench",
            json!({ "action": "worktree-remove", "branch": { "existing": "refs/heads/topic" }, "path": "C:\\src\\wt" }),
        );
        assert_eq!(native_first(&other).map(drop), Err("INVALID_REQUEST"));

        // Each feature 004 phase carries only its own counters.
        let event = |phase: &str, counters: Value| json!({ "requestId": "0f0f0f0f-0000-4000-8000-000000000001", "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "state": "running", "phase": phase, "counters": counters, "stalled": false });
        let bare = [
            "switch-stash",
            "switch-checkout",
            "switch-reapply",
            "switch-drop",
            "branch",
            "merge",
            "rebase",
            "resolve",
            "mergetool",
            "worktree",
            "ignore",
        ];
        for phase in bare {
            assert!(progress(&event(phase, json!({}))), "{phase}");
            for counter in ["percent", "fileIndex", "keyIndex", "objects"] {
                assert!(
                    !progress(&event(phase, json!({ counter: 1 }))),
                    "{phase} {counter}"
                );
            }
        }
        for (phase, own, foreign) in [
            ("stage-files", ["fileIndex", "fileCount"], "keyIndex"),
            ("config", ["keyIndex", "keyCount"], "fileIndex"),
        ] {
            assert!(progress(&event(phase, json!({}))), "{phase}");
            assert!(
                progress(&event(phase, json!({ own[0]: 1, own[1]: 2 }))),
                "{phase}"
            );
            for counter in [foreign, "percent", "objects"] {
                assert!(
                    !progress(&event(phase, json!({ counter: 1 }))),
                    "{phase} {counter}"
                );
            }
        }

        // Kind `workbench` carries one workbench action, and kind `applyFiles` carries `stage` or `unstage`.
        let started = |fields: Value| {
            let mut frame = json!({ "type": "started", "callId": "0f0f0f0f-0000-4000-8000-000000000003", "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005", "worktreeRoot": "//host/repo", "commonDirectory": "//host/repo/.git" });
            frame
                .as_object_mut()
                .expect("object")
                .extend(fields.as_object().expect("fields").clone());
            mutation_request(&frame).is_ok()
        };
        for action in [
            "switch",
            "create-branch",
            "rename-branch",
            "delete-branch",
            "merge",
            "rebase",
            "choose-ours",
            "choose-theirs",
            "mergetool",
            "ignore-gitignore",
            "ignore-exclude",
            "worktree-add",
            "worktree-remove",
            "worktree-prune",
            "config-save",
        ] {
            assert!(
                started(json!({ "kind": "workbench", "action": action })),
                "{action}"
            );
            assert!(
                !started(json!({ "kind": "sync", "action": action })),
                "{action}"
            );
            assert!(
                !started(json!({ "kind": "applyFiles", "direction": "stage", "action": action })),
                "{action}"
            );
        }
        for direction in ["stage", "unstage"] {
            assert!(started(
                json!({ "kind": "applyFiles", "direction": direction })
            ));
        }
        for fields in [
            json!({ "kind": "workbench" }),
            json!({ "kind": "workbench", "action": "fetch" }),
            json!({ "kind": "workbench", "action": "switch", "direction": "stage" }),
            json!({ "kind": "applyFiles" }),
            json!({ "kind": "applyFiles", "direction": "resolve" }),
        ] {
            assert!(!started(fields.clone()), "{fields}");
        }
    }

    /// Feature 004 contract Δ6: the `fileAppend` and `reveal` replies in their wire form.
    #[test]
    fn the_file_append_and_reveal_replies_have_their_wire_form() {
        use crate::file_append::AppendResult;
        use process_reply::FileAppendErrorCode as E;
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors/valid");
        let vector = |name: &str| -> Value {
            let text = std::fs::read_to_string(root.join(name)).expect("vector file");
            let vector: Vector = serde_json::from_str(&text).expect("vector form");
            serde_json::from_str(&vector.text).expect("vector text")
        };
        let call = "0f0f0f0f-0000-4000-8000-000000000001";
        for (built, expected) in [
            (
                reply::file_append(call, AppendResult::Appended),
                vector("process-reply-file-append-appended.json"),
            ),
            (
                reply::file_append(call, AppendResult::NotRegular),
                vector("process-reply-file-append-refused.json"),
            ),
            (
                reply::file_append(call, AppendResult::Stale),
                json!({ "type": "fileAppend", "callId": call, "result": "stale" }),
            ),
            (
                reply::file_append(call, AppendResult::Stopped),
                vector("process-reply-file-append-stopped.json"),
            ),
            (
                reply::file_append(call, AppendResult::Interrupted),
                json!({ "type": "fileAppend", "callId": call, "result": "interrupted" }),
            ),
            (
                reply::file_append(call, AppendResult::Error(E::SharingViolation)),
                json!({ "type": "fileAppend", "callId": call, "result": "error", "code": "sharing-violation" }),
            ),
            (reply::reveal(call), vector("process-reply-reveal.json")),
        ] {
            assert_eq!(built, expected);
            assert!(
                typed::<process_reply::ProcessReply>(&built).is_some(),
                "{built}"
            );
        }
    }

    /// Feature 004 contract Δ6: the `destinationFacts` reply to the `worktreeAdd` form carries `path`, and the clone reply none.
    #[test]
    fn the_worktree_add_destination_facts_reply_carries_its_path() {
        use crate::process_requests::Destination;
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors/valid");
        let text =
            std::fs::read_to_string(root.join("process-reply-destination-facts-worktree-add.json"))
                .expect("vector file");
        let vector: Vector = serde_json::from_str(&text).expect("vector form");
        let expected: Value = serde_json::from_str(&vector.text).expect("vector text");
        let call = "0f0f0f0f-0000-4000-8000-000000000001";
        let built = reply::destination_facts(call, Destination::Absent, Some("/home/u/repo-wt"));
        assert_eq!(built, expected);
        let error = reply::destination_facts(call, Destination::Error("io-error"), Some("C:\\wt"));
        assert_eq!(
            error,
            json!({ "type": "destinationFacts", "callId": call, "result": "error", "code": "io-error", "path": "C:\\wt" })
        );
        let clone = reply::destination_facts(call, Destination::Empty, None);
        assert_eq!(
            clone,
            json!({ "type": "destinationFacts", "callId": call, "result": "empty" })
        );
        for built in [built, error, clone] {
            assert!(
                typed::<process_reply::ProcessReply>(&built).is_some(),
                "{built}"
            );
        }
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
                    Err("INVALID_REQUEST"),
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
                Err("INVALID_REQUEST"),
                "{payload}"
            );
        }
    }
}
