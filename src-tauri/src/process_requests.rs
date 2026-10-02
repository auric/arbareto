// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shell does not use these items yet. T037 removes this attribute.
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use crate::bootstrap::{Contexts, Identity};
use crate::jobs::Supervisor;

/// Contract §5 "Native stdout/stderr chunk": decoded bytes in one `output` or `input` frame.
pub const CHUNK_BYTES: usize = 64 * 1024;
/// Contract §5 "Queued pipe data": queued chunks per stream, and unacknowledged input chunks per process.
pub const QUEUED_CHUNKS_PER_STREAM: usize = 8;
/// Contract §5 "Inline process input".
pub const INLINE_INPUT_BYTES: usize = 64 * 1024;
/// Contract §5 "Streamed process input".
pub const STREAMED_INPUT_BYTES: u64 = 536_870_912;
/// Contract §6: an identity request carries at most 8 paths.
pub const IDENTITY_PATHS: usize = 8;
/// Contract §6 "Channel frames": a path has at most 32,767 UTF-16 units.
pub const PATH_UNITS: usize = 32_767;
/// Contract §6 "Channel frames" `limits` caps, in milliseconds.
pub const BOOTSTRAP_DEADLINE_MS: u64 = 30_000;
pub const WSL_START_DEADLINE_MS: u64 = 60_000;
pub const REGISTERED_DEADLINE_MS: u64 = 120_000;
pub const INACTIVITY_MS: u64 = 300_000;
pub const CEILING_MS: u64 = 14_400_000;
pub const STALL_MS: u64 = 15_000;
/// Contract §6 "Context rules": `register` field `version` is printable ASCII.
pub const VERSION_BYTES: usize = 64;

/// Writes one frame body to the service. A queued chunk leaves its queue when this call returns.
pub type ReplySink = Arc<dyn Fn(String) + Send + Sync>;

pub struct Config {
    /// The application-owned launch directory of a `gitProbe` run (contract §6 "Channel frames").
    pub launch_directory: PathBuf,
    /// `git_env` builds each child environment from this environment.
    pub base_environment: Vec<(OsString, OsString)>,
    /// Arguments before the request arguments at the `CreateProcessW` boundary, after validation.
    /// The product passes none. Tests pass the libtest arguments that re-execute the test binary.
    pub argument_prefix: Vec<String>,
}

/// The shell side of the private `process` channel (contract §6 "Channel frames").
pub struct ProcessRequests {
    _private: (),
}

impl ProcessRequests {
    pub fn new(
        _config: Config,
        _contexts: Arc<Contexts>,
        _jobs: Arc<Supervisor>,
        _sink: ReplySink,
    ) -> Arc<ProcessRequests> {
        todo!("T035")
    }

    /// Handles one `process` frame body. It never waits on a child pipe.
    pub fn handle(&self, _body: &str) {
        todo!("T035")
    }

    /// Tags the Job of a mutation with the common-directory identity that the `started` frame read.
    pub fn tag(&self, _operation_id: &str, _common_identity: Identity) {
        todo!("T035")
    }

    /// Handles the `mutation` frame `ended` (contract §6 "Lingering Jobs").
    pub fn ended(&self, _operation_id: &str, _end_processes: bool) {
        todo!("T035")
    }

    /// Drops every pending call, and closes every operation Job outside the lingering set.
    pub fn service_exited(&self) {
        todo!("T035")
    }

    /// Test hook: the largest number of chunks that one stream queue held.
    pub fn peak_queued_chunks(&self) -> usize {
        todo!("T035")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Read;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Condvar, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use serde_json::{Map, Value, json};

    use crate::bootstrap::{ContextKind, read_identity};
    use crate::jobs::tests::{
        CHILD_PREFIX, CLOSE_BOUND, Fixture, Proc, WAIT, eventually, test_exe, wait_file,
    };

    // ---- Standard base64 with padding ----

    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn encode(bytes: &[u8]) -> String {
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (chunk[0] as u32) << 16
                | (*chunk.get(1).unwrap_or(&0) as u32) << 8
                | *chunk.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                out.push(if i <= chunk.len() {
                    ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char
                } else {
                    '='
                });
            }
        }
        out
    }

    fn decode(text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0);
        for c in text.bytes().filter(|&c| c != b'=') {
            acc = acc << 6 | ALPHABET.iter().position(|&a| a == c).expect("base64 digit") as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        out
    }

    // ---- Harness ----

    fn uuid() -> String {
        static NEXT: AtomicU32 = AtomicU32::new(1);
        format!(
            "{:08x}-0000-4000-8000-{:012x}",
            NEXT.fetch_add(1, Ordering::SeqCst),
            std::process::id()
        )
    }

    /// Blocks the reply sink while closed. Each wait ends after 60 s, so a failed test never holds a shell thread forever.
    struct Gate {
        open: Mutex<bool>,
        changed: Condvar,
    }

    impl Gate {
        fn set(&self, open: bool) {
            *self.open.lock().expect("gate") = open;
            self.changed.notify_all();
        }

        fn pass(&self) {
            let guard = self.open.lock().expect("gate");
            let _ = self
                .changed
                .wait_timeout_while(guard, Duration::from_secs(60), |open| !*open);
        }
    }

    type Replies = Arc<(Mutex<Vec<(Instant, Value)>>, Condvar)>;

    struct Harness {
        requests: Arc<ProcessRequests>,
        contexts: Arc<Contexts>,
        jobs: Arc<Supervisor>,
        replies: Replies,
        gate: Arc<Gate>,
        fixture: Fixture,
    }

    struct Workspace {
        git: String,
        repository: String,
        worktree: PathBuf,
    }

    impl Harness {
        /// The test binary acts as Git: each run starts `child_entry` with the request arguments.
        fn child() -> Harness {
            Harness::new(
                Fixture::new(),
                CHILD_PREFIX.iter().map(|s| s.to_string()).collect(),
                std::env::vars_os().collect(),
            )
        }

        fn new(
            fixture: Fixture,
            argument_prefix: Vec<String>,
            base_environment: Vec<(OsString, OsString)>,
        ) -> Harness {
            let contexts = Arc::new(Contexts::new(&uuid()));
            let jobs = Supervisor::start().expect("start the supervisor");
            let replies: Replies = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
            let gate = Arc::new(Gate {
                open: Mutex::new(true),
                changed: Condvar::new(),
            });
            let sink: ReplySink = {
                let (replies, gate) = (Arc::clone(&replies), Arc::clone(&gate));
                Arc::new(move |body: String| {
                    gate.pass();
                    let frame: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    let shaped =
                        frame["kind"] == "process" && frame.as_object().map(Map::len) == Some(2);
                    let reply = if shaped {
                        frame["process"].clone()
                    } else {
                        json!({ "type": "BAD_FRAME", "body": body })
                    };
                    let (list, changed) = &*replies;
                    list.lock().expect("replies").push((Instant::now(), reply));
                    changed.notify_all();
                })
            };
            let launch_directory = fixture.path("launch");
            std::fs::create_dir(&launch_directory).expect("launch directory");
            let config = Config {
                launch_directory,
                base_environment,
                argument_prefix,
            };
            let requests =
                ProcessRequests::new(config, Arc::clone(&contexts), Arc::clone(&jobs), sink);
            Harness {
                requests,
                contexts,
                jobs,
                replies,
                gate,
                fixture,
            }
        }

        fn send(&self, inner: Value) {
            self.requests
                .handle(&json!({ "kind": "process", "process": inner }).to_string());
        }

        fn wait_reply(
            &self,
            timeout: Duration,
            mut matches: impl FnMut(&Value) -> bool,
        ) -> Option<(Instant, Value)> {
            let (list, changed) = &*self.replies;
            let deadline = Instant::now() + timeout;
            let mut guard = list.lock().expect("replies");
            loop {
                if let Some(found) = guard.iter().find(|(_, v)| matches(v)) {
                    return Some(found.clone());
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return None;
                }
                guard = changed.wait_timeout(guard, left).expect("replies").0;
            }
        }

        fn reply(&self, call_id: &str) -> Value {
            self.wait_reply(WAIT, |v| v["callId"] == call_id)
                .unwrap_or_else(|| panic!("no reply for {call_id}"))
                .1
        }

        fn replies_for(&self, call_id: &str) -> Vec<(Instant, Value)> {
            self.replies
                .0
                .lock()
                .expect("replies")
                .iter()
                .filter(|(_, v)| v["callId"] == call_id)
                .cloned()
                .collect()
        }

        fn all_replies(&self) -> Vec<Value> {
            self.replies
                .0
                .lock()
                .expect("replies")
                .iter()
                .map(|(_, v)| v.clone())
                .collect()
        }

        fn exit(&self, call_id: &str, timeout: Duration) -> Option<(Instant, Value)> {
            self.wait_reply(timeout, |v| v["callId"] == call_id && v["type"] == "exit")
        }

        fn output(&self, call_id: &str, stream: &str) -> Vec<u8> {
            let frames = self.replies_for(call_id);
            frames
                .iter()
                .filter(|(_, v)| v["type"] == "output" && v["stream"] == stream)
                .flat_map(|(_, v)| decode(v["data"].as_str().expect("data")))
                .collect()
        }

        /// Waits for a `<marker> <text>` line in the decoded output of the call. Returns the text.
        fn output_line(&self, call_id: &str, stream: &str, marker: &str) -> String {
            let needle = format!("{marker} ");
            let mut found = None;
            eventually(WAIT, || {
                let text = String::from_utf8_lossy(&self.output(call_id, stream)).into_owned();
                found = text.lines().find_map(|line| {
                    line.find(&needle)
                        .map(|at| line[at + needle.len()..].trim_end().to_string())
                });
                found.is_some()
            });
            found.unwrap_or_else(|| panic!("no `{marker}` line in the {stream} of {call_id}"))
        }

        fn register(&self, mut body: Value) {
            let call = uuid();
            body["type"] = json!("register");
            body["callId"] = json!(call);
            body["operationId"] = json!(uuid());
            self.send(body);
            assert_eq!(
                self.reply(&call),
                json!({ "type": "register", "callId": call, "result": "approved" })
            );
        }

        fn register_git(&self, program: &Path) -> String {
            let bootstrap_id = self
                .contexts
                .create(ContextKind::GitProbe, program, Instant::now())
                .expect("gitProbe context");
            let git = uuid();
            self.register(json!({ "bootstrapId": bootstrap_id, "gitInstallationId": git, "version": "2.55.0.windows.3", "confirm": false }));
            git
        }

        fn register_repository(&self, git: &str, worktree: &Path) -> String {
            let bootstrap_id = self
                .contexts
                .create(ContextKind::RepositoryDiscovery, worktree, Instant::now())
                .expect("discovery context");
            let repository = uuid();
            let git_directory = worktree.join(".git");
            self.register(json!({
                "bootstrapId": bootstrap_id, "gitInstallationId": git, "repositoryId": repository,
                "worktreeRoot": worktree, "gitDirectory": git_directory, "commonDirectory": git_directory,
            }));
            repository
        }

        /// Registers the test binary as Git and an owned folder as the repository.
        fn child_workspace(&self, name: &str) -> Workspace {
            let worktree = self.fixture.path(name);
            std::fs::create_dir_all(worktree.join(".git")).expect("worktree");
            let git = self.register_git(&test_exe());
            let repository = self.register_repository(&git, &worktree);
            Workspace {
                git,
                repository,
                worktree,
            }
        }

        fn run(&self, operation: &str, workspace: &Workspace, mode: &[&str]) -> String {
            let call = uuid();
            self.send(run_body(
                &call,
                operation,
                workspace,
                mode,
                "read",
                json!({ "deadlineMs": 30_000 }),
            ));
            call
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.gate.set(true);
            self.jobs.close_all();
            self.jobs.shutdown();
        }
    }

    fn run_body(
        call: &str,
        operation: &str,
        workspace: &Workspace,
        mode: &[&str],
        policy: &str,
        limits: Value,
    ) -> Value {
        let mut arguments = vec!["--no-lazy-fetch".to_string()];
        arguments.extend(mode.iter().map(|s| s.to_string()));
        json!({
            "type": "run", "callId": call, "operationId": operation, "contextKind": "registeredOperation",
            "gitInstallationId": workspace.git, "repositoryId": workspace.repository,
            "arguments": arguments, "environmentPolicy": policy, "limits": limits,
        })
    }

    fn refused(call: &str, code: &str) -> Value {
        json!({ "type": "refused", "callId": call, "code": code })
    }

    type Edit = Box<dyn Fn(&mut Map<String, Value>)>;

    fn set(key: &'static str, value: Value) -> Edit {
        Box::new(move |m| {
            m.insert(key.to_string(), value.clone());
        })
    }

    fn remove(key: &'static str) -> Edit {
        Box::new(move |m| {
            m.remove(key);
        })
    }

    fn both(a: Edit, b: Edit) -> Edit {
        Box::new(move |m| {
            a(m);
            b(m);
        })
    }

    /// Sends `base` with each edit and expects `refused` with `code`. Afterwards, no refused call has any other reply.
    fn expect_refusals(
        harness: &Harness,
        base: impl Fn(&str) -> Value,
        cases: Vec<(&str, Edit)>,
        code: &str,
    ) {
        let mut calls = Vec::new();
        for (name, edit) in cases {
            let call = uuid();
            let mut body = base(&call);
            edit(body.as_object_mut().expect("object"));
            harness.send(body);
            assert_eq!(harness.reply(&call), refused(&call, code), "{name}");
            calls.push(call);
        }
        std::thread::sleep(Duration::from_millis(500));
        for call in calls {
            assert_eq!(
                harness.replies_for(&call).len(),
                1,
                "a refused request starts nothing: {call}"
            );
        }
    }

    // ---- Field validation (contract §6 "Process fields" and "Channel frames") ----

    #[test]
    fn run_requests_that_break_a_field_rule_get_refused_invalid_request() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let git_directory = workspace.worktree.join(".git");
        let candidate = json!(git_directory.join("arbareto-candidate-0001"));
        let mutation = || set("environmentPolicy", json!("mutation"));
        let cases: Vec<(&str, Edit)> = vec![
            ("unknown field", set("extra", json!(1))),
            ("missing limits", remove("limits")),
            ("missing environmentPolicy", remove("environmentPolicy")),
            ("missing arguments", remove("arguments")),
            (
                "arguments not an array",
                set("arguments", json!("--no-lazy-fetch sleep 10")),
            ),
            (
                "argument not a string",
                set("arguments", json!(["--no-lazy-fetch", 5])),
            ),
            (
                "argument with NUL",
                set("arguments", json!(["--no-lazy-fetch", "sleep", "a\u{0}b"])),
            ),
            (
                "no leading --no-lazy-fetch",
                set("arguments", json!(["sleep", "10"])),
            ),
            (
                "quoted command line above 32,767 units",
                set(
                    "arguments",
                    json!(["--no-lazy-fetch", "sleep", "a".repeat(32_767)]),
                ),
            ),
            ("unknown contextKind", set("contextKind", json!("shell"))),
            (
                "bootstrapId for registeredOperation",
                set("bootstrapId", json!(uuid())),
            ),
            ("missing repositoryId", remove("repositoryId")),
            ("missing gitInstallationId", remove("gitInstallationId")),
            ("malformed operationId", set("operationId", json!("op"))),
            (
                "environmentPolicy not fixed",
                set("environmentPolicy", json!("custom")),
            ),
            (
                "probe policy for registeredOperation",
                set("environmentPolicy", json!("probe")),
            ),
            (
                "transactionId with read",
                both(
                    set("transactionId", json!(uuid())),
                    set("indexFile", candidate.clone()),
                ),
            ),
            (
                "indexFile without transactionId",
                both(mutation(), set("indexFile", candidate.clone())),
            ),
            (
                "transactionId without indexFile",
                both(mutation(), set("transactionId", json!(uuid()))),
            ),
            (
                "indexFile without the candidate prefix",
                both(
                    mutation(),
                    both(
                        set("transactionId", json!(uuid())),
                        set("indexFile", json!(git_directory.join("index"))),
                    ),
                ),
            ),
            (
                "indexFile outside the Git directory",
                both(
                    mutation(),
                    both(
                        set("transactionId", json!(uuid())),
                        set(
                            "indexFile",
                            json!(workspace.worktree.join("arbareto-candidate-0001")),
                        ),
                    ),
                ),
            ),
            (
                "input and inputBytes",
                both(
                    set("input", json!(encode(b"a"))),
                    set("inputBytes", json!(1)),
                ),
            ),
            ("empty input", set("input", json!(""))),
            (
                "input above 64 KiB",
                set("input", json!(encode(&vec![b'x'; INLINE_INPUT_BYTES + 1]))),
            ),
            ("input not base64", set("input", json!("***"))),
            ("inputBytes 0", set("inputBytes", json!(0))),
            (
                "inputBytes above 512 MiB",
                set("inputBytes", json!(STREAMED_INPUT_BYTES + 1)),
            ),
            ("inputBytes not an integer", set("inputBytes", json!(1.5))),
            ("deadlineMs 0", set("limits", json!({ "deadlineMs": 0 }))),
            (
                "deadlineMs above 120 s",
                set(
                    "limits",
                    json!({ "deadlineMs": REGISTERED_DEADLINE_MS + 1 }),
                ),
            ),
            ("deadlineMs missing", set("limits", json!({}))),
            (
                "deadlineMs a string",
                set("limits", json!({ "deadlineMs": "30000" })),
            ),
            (
                "stallMs not 15 s",
                set(
                    "limits",
                    json!({ "deadlineMs": 30_000, "stallMs": STALL_MS - 1 }),
                ),
            ),
            (
                "inactivityMs without network",
                set(
                    "limits",
                    json!({ "deadlineMs": 30_000, "inactivityMs": 1000 }),
                ),
            ),
            (
                "ceilingMs without network",
                set("limits", json!({ "deadlineMs": 30_000, "ceilingMs": 1000 })),
            ),
            (
                "unknown limits field",
                set("limits", json!({ "deadlineMs": 30_000, "cpuMs": 1 })),
            ),
        ];
        let base = |call: &str| {
            run_body(
                call,
                &operation,
                &workspace,
                &["sleep", "10"],
                "read",
                json!({ "deadlineMs": 30_000 }),
            )
        };
        expect_refusals(&harness, base, cases, "INVALID_REQUEST");
        // A lone surrogate exists only as a JSON escape, because a frame body is UTF-8.
        let call = uuid();
        let mut body = run_body(
            &call,
            &operation,
            &workspace,
            &["sleep", "LONE"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        );
        body["arguments"][2] = json!("LONE");
        harness.requests.handle(
            &json!({ "kind": "process", "process": body })
                .to_string()
                .replace("LONE", "\\ud800"),
        );
        assert_eq!(
            harness.reply(&call),
            refused(&call, "INVALID_REQUEST"),
            "argument with a lone surrogate"
        );
    }

    #[test]
    fn bootstrap_runs_follow_their_context_rules() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let probe = |call: &str, operation: &str, bootstrap: &str| {
            json!({
                "type": "run", "callId": call, "operationId": operation, "contextKind": "gitProbe", "bootstrapId": bootstrap,
                "arguments": ["version", "--build-options"], "environmentPolicy": "probe", "limits": { "deadlineMs": 30_000 },
            })
        };
        let new_probe = || {
            harness
                .contexts
                .create(ContextKind::GitProbe, &test_exe(), Instant::now())
                .expect("context")
        };
        // Positive control: a valid probe run starts the selected program from the launch directory.
        let call = uuid();
        harness.send(probe(&call, &uuid(), &new_probe()));
        assert_eq!(harness.exit(&call, WAIT).expect("exit").1["exitCode"], 0);
        assert!(
            String::from_utf8_lossy(&harness.output(&call, "stdout"))
                .contains("git version 2.55.0.windows.3")
        );
        let probe_cases: Vec<(&str, Edit)> = vec![
            (
                "probe with --no-lazy-fetch",
                set(
                    "arguments",
                    json!(["--no-lazy-fetch", "version", "--build-options"]),
                ),
            ),
            (
                "probe with other arguments",
                set("arguments", json!(["rev-parse", "--show-toplevel"])),
            ),
            (
                "probe with gitInstallationId",
                set("gitInstallationId", json!(workspace.git)),
            ),
            (
                "probe with repositoryId",
                set("repositoryId", json!(workspace.repository)),
            ),
            ("probe without bootstrapId", remove("bootstrapId")),
            (
                "probe with the read policy",
                set("environmentPolicy", json!("read")),
            ),
            (
                "probe deadline above 30 s",
                set("limits", json!({ "deadlineMs": BOOTSTRAP_DEADLINE_MS + 1 })),
            ),
            (
                "probe with stallMs",
                set(
                    "limits",
                    json!({ "deadlineMs": 30_000, "stallMs": STALL_MS }),
                ),
            ),
        ];
        expect_refusals(
            &harness,
            |call| probe(call, &uuid(), &new_probe()),
            probe_cases,
            "INVALID_REQUEST",
        );
        let directory = harness.fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let discovery = |call: &str| {
            let bootstrap = harness
                .contexts
                .create(ContextKind::RepositoryDiscovery, &directory, Instant::now())
                .expect("context");
            json!({
                "type": "run", "callId": call, "operationId": uuid(), "contextKind": "repositoryDiscovery", "bootstrapId": bootstrap,
                "gitInstallationId": workspace.git, "arguments": ["--no-lazy-fetch", "rev-parse", "--show-toplevel"],
                "environmentPolicy": "probe", "limits": { "deadlineMs": 30_000 },
            })
        };
        let discovery_cases: Vec<(&str, Edit)> = vec![
            (
                "discovery without gitInstallationId",
                remove("gitInstallationId"),
            ),
            (
                "discovery with repositoryId",
                set("repositoryId", json!(workspace.repository)),
            ),
            (
                "discovery of a status read",
                set(
                    "arguments",
                    json!(["--no-lazy-fetch", "status", "--porcelain=v2"]),
                ),
            ),
            (
                "discovery of a mutation",
                set(
                    "arguments",
                    json!(["--no-lazy-fetch", "commit", "--quiet", "--file=-"]),
                ),
            ),
            (
                "discovery with the mutation policy",
                set("environmentPolicy", json!("mutation")),
            ),
        ];
        expect_refusals(&harness, discovery, discovery_cases, "INVALID_REQUEST");
    }

    #[test]
    fn inactive_unbound_and_expired_ids_get_unknown_target() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let probe = |call: &str, operation: &str, bootstrap: &str, kind: &str| {
            json!({
                "type": "run", "callId": call, "operationId": operation, "contextKind": kind, "bootstrapId": bootstrap,
                "arguments": ["version", "--build-options"], "environmentPolicy": "probe", "limits": { "deadlineMs": 30_000 },
            })
        };
        let mut calls = Vec::new();
        let mut expect = |call: String, name: &str| {
            assert_eq!(
                harness.reply(&call),
                refused(&call, "UNKNOWN_TARGET"),
                "{name}"
            );
            calls.push(call);
        };
        let unbound_repository = Workspace {
            git: workspace.git.clone(),
            repository: uuid(),
            worktree: workspace.worktree.clone(),
        };
        let call = uuid();
        harness.send(run_body(
            &call,
            &uuid(),
            &unbound_repository,
            &["sleep", "10"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        expect(call, "unbound repositoryId");
        let unbound_git = Workspace {
            git: uuid(),
            repository: workspace.repository.clone(),
            worktree: workspace.worktree.clone(),
        };
        let call = uuid();
        harness.send(run_body(
            &call,
            &uuid(),
            &unbound_git,
            &["sleep", "10"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        expect(call, "unbound gitInstallationId");
        match Instant::now().checked_sub(Duration::from_secs(61)) {
            Some(earlier) => {
                let expired = harness
                    .contexts
                    .create(ContextKind::GitProbe, &test_exe(), earlier)
                    .expect("context");
                let call = uuid();
                harness.send(probe(&call, &uuid(), &expired, "gitProbe"));
                expect(call, "expired context");
            }
            None => println!("SKIP: expired-context case needs a system uptime above 61 s"),
        }
        let other_kind = harness
            .contexts
            .create(ContextKind::GitProbe, &test_exe(), Instant::now())
            .expect("context");
        let call = uuid();
        let mut body = probe(&call, &uuid(), &other_kind, "repositoryDiscovery");
        body["gitInstallationId"] = json!(workspace.git);
        body["arguments"] = json!(["--no-lazy-fetch", "rev-parse", "--show-toplevel"]);
        harness.send(body);
        expect(call, "context of another kind");
        let owned = harness
            .contexts
            .create(ContextKind::GitProbe, &test_exe(), Instant::now())
            .expect("context");
        let first = uuid();
        harness.send(probe(&first, &uuid(), &owned, "gitProbe"));
        harness
            .exit(&first, WAIT)
            .expect("the first operation owns the context");
        let call = uuid();
        harness.send(probe(&call, &uuid(), &owned, "gitProbe"));
        expect(call, "context owned by another operationId");
        let ended = uuid();
        let first = harness.run(&ended, &workspace, &["sleep", "10"]);
        harness.exit(&first, WAIT).expect("exit");
        harness.send(json!({ "type": "closeJob", "operationId": ended }));
        let call = uuid();
        harness.send(run_body(
            &call,
            &ended,
            &workspace,
            &["sleep", "10"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        expect(call, "operationId after closeJob");
        let released = harness.child_workspace("released");
        harness.send(json!({ "type": "release", "repositoryId": released.repository }));
        let call = uuid();
        harness.send(run_body(
            &call,
            &uuid(),
            &released,
            &["sleep", "10"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        expect(call, "released repositoryId");
        let released_git = harness.child_workspace("released-git");
        harness.send(json!({ "type": "release", "gitInstallationId": released_git.git }));
        let call = uuid();
        harness.send(run_body(
            &call,
            &uuid(),
            &released_git,
            &["sleep", "10"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        expect(call, "released gitInstallationId");
        std::thread::sleep(Duration::from_millis(500));
        for call in calls {
            assert_eq!(
                harness.replies_for(&call).len(),
                1,
                "a refused request starts nothing: {call}"
            );
        }
    }

    #[test]
    fn other_request_bodies_are_validated_by_the_channel_frames() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let identity = |call: &str| {
            json!({
                "type": "identity", "callId": call, "operationId": operation, "contextKind": "registeredOperation",
                "gitInstallationId": workspace.git, "repositoryId": workspace.repository, "paths": [workspace.worktree],
            })
        };
        let long_path = format!(r"C:\{}", "a".repeat(PATH_UNITS));
        let identity_cases: Vec<(&str, Edit)> = vec![
            ("identity without paths", set("paths", json!([]))),
            (
                "identity with nine paths",
                set(
                    "paths",
                    json!(vec![workspace.worktree.clone(); IDENTITY_PATHS + 1]),
                ),
            ),
            (
                "identity with a NUL path",
                set("paths", json!(["C:\\a\u{0}b"])),
            ),
            (
                "identity with a path above 32,767 units",
                set("paths", json!([long_path])),
            ),
            (
                "identity with a relative path",
                set("paths", json!(["relative\\dir"])),
            ),
            ("identity with a non-string path", set("paths", json!([7]))),
            ("identity without contextKind", remove("contextKind")),
            ("identity with an unknown field", set("extra", json!(true))),
        ];
        expect_refusals(&harness, identity, identity_cases, "INVALID_REQUEST");
        let lingering = |call: &str| json!({ "type": "lingeringCount", "callId": call, "operationId": operation, "commonDirectory": workspace.worktree.join(".git") });
        let lingering_cases: Vec<(&str, Edit)> = vec![
            (
                "lingeringCount without commonDirectory",
                remove("commonDirectory"),
            ),
            (
                "lingeringCount with a relative path",
                set("commonDirectory", json!("relative")),
            ),
            (
                "lingeringCount with an unknown field",
                set("paths", json!([])),
            ),
        ];
        expect_refusals(&harness, lingering, lingering_cases, "INVALID_REQUEST");
        let register = |call: &str| {
            let bootstrap = harness
                .contexts
                .create(ContextKind::GitProbe, &test_exe(), Instant::now())
                .expect("context");
            json!({ "type": "register", "callId": call, "operationId": uuid(), "bootstrapId": bootstrap, "gitInstallationId": uuid(), "version": "2.55.0", "confirm": false })
        };
        let register_cases: Vec<(&str, Edit)> = vec![
            (
                "register with version and repositoryId",
                set("repositoryId", json!(uuid())),
            ),
            (
                "register with a 65-byte version",
                set("version", json!("9".repeat(VERSION_BYTES + 1))),
            ),
            (
                "register with a non-printable version",
                set("version", json!("2.55\u{7}")),
            ),
            (
                "register with a non-boolean confirm",
                set("confirm", json!("no")),
            ),
            ("register without bootstrapId", remove("bootstrapId")),
        ];
        expect_refusals(&harness, register, register_cases, "INVALID_REQUEST");
        let call = uuid();
        harness.send(json!({ "type": "spawnShell", "callId": call }));
        assert_eq!(
            harness.reply(&call),
            refused(&call, "INVALID_REQUEST"),
            "unknown type"
        );
        let call = uuid();
        harness.requests.handle(
            &json!({ "kind": "process", "process": identity(&call), "extra": 1 }).to_string(),
        );
        assert_eq!(
            harness.reply(&call),
            refused(&call, "INVALID_REQUEST"),
            "a frame body with a third key"
        );
        let running = uuid();
        let run = harness.run(&running, &workspace, &["sleep", "60000"]);
        harness.output_line(&run, "stdout", "PID");
        harness.send(json!({ "type": "cancel", "callId": run, "extra": 1 }));
        assert_eq!(
            harness
                .wait_reply(WAIT, |v| v["callId"] == run && v["type"] == "refused")
                .map(|r| r.1),
            Some(refused(&run, "INVALID_REQUEST"))
        );
        harness.send(json!({ "type": "input", "callId": run, "data": encode(b"x"), "extra": 1 }));
        // A malformed request without `callId` is dropped and changes nothing.
        harness.send(json!({ "type": "release", "repositoryId": workspace.repository, "gitInstallationId": workspace.git }));
        harness.send(json!({ "type": "closeJob", "operationId": running, "extra": 1 }));
        assert!(
            harness.exit(&run, Duration::from_secs(1)).is_none(),
            "the malformed closeJob closed nothing"
        );
        let still_bound = harness.run(&uuid(), &workspace, &["sleep", "10"]);
        assert_eq!(
            harness
                .exit(&still_bound, WAIT)
                .expect("the malformed release released nothing")
                .1["exitCode"],
            0
        );
        harness.send(json!({ "type": "closeJob", "operationId": running }));
        assert!(
            harness.exit(&run, CLOSE_BOUND).is_some(),
            "a valid closeJob ends the run"
        );
    }

    #[test]
    fn malformed_frames_without_a_valid_call_id_are_dropped() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let before = harness.all_replies().len();
        for body in [
            "not JSON".to_string(),
            "[1,2]".to_string(),
            r#"{"kind":"process"}"#.to_string(),
            json!({ "kind": "process", "process": { "type": "run" } }).to_string(),
            json!({ "kind": "process", "process": { "type": "identity", "callId": "short", "paths": [] } }).to_string(),
            json!({ "kind": "process", "process": { "type": "identity", "callId": 5 } }).to_string(),
        ] {
            harness.requests.handle(&body);
        }
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(
            harness.all_replies().len(),
            before,
            "no reply: {:?}",
            &harness.all_replies()[before..]
        );
        let call = harness.run(&uuid(), &workspace, &["sleep", "10"]);
        assert!(
            harness.exit(&call, WAIT).is_some(),
            "the channel still works"
        );
    }

    // ---- Output, backpressure, and input ----

    #[test]
    fn stdout_and_stderr_drain_independently_in_64_kib_chunks() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let call = harness.run(&uuid(), &workspace, &["both", "1048576"]);
        let exit = harness
            .exit(&call, Duration::from_secs(30))
            .expect("a blocked stderr never stalls the process");
        assert_eq!(exit.1["exitCode"], 0);
        // libtest writes its own text before the child mode runs.
        assert!(
            harness
                .output(&call, "stderr")
                .ends_with(&vec![b'e'; 1_048_576]),
            "stderr holds every byte"
        );
        assert!(
            harness
                .output(&call, "stdout")
                .ends_with(&vec![b'o'; 1_048_576]),
            "stdout holds every byte"
        );
        for (_, frame) in harness
            .replies_for(&call)
            .iter()
            .filter(|(_, v)| v["type"] == "output")
        {
            let size = decode(frame["data"].as_str().expect("data")).len();
            assert!((1..=CHUNK_BYTES).contains(&size), "a chunk of {size} bytes");
        }
        assert!(harness.requests.peak_queued_chunks() <= QUEUED_CHUNKS_PER_STREAM);
    }

    #[test]
    fn a_full_queue_stops_the_reads_of_that_child_pipe() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let progress = harness.fixture.path("progress.txt");
        harness.gate.set(false);
        let call = harness.run(
            &uuid(),
            &workspace,
            &[
                "write",
                "stdout",
                "4194304",
                progress.to_str().expect("path"),
            ],
        );
        std::thread::sleep(Duration::from_secs(2));
        let written = |p: &Path| {
            std::fs::read_to_string(p)
                .ok()
                .and_then(|t| t.parse::<usize>().ok())
                .unwrap_or(0)
        };
        let stalled = written(&progress);
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(written(&progress), stalled, "the child waits on its write");
        assert!(
            stalled < 2 * 1024 * 1024,
            "the shell stopped reading: {stalled} bytes written"
        );
        assert!(
            harness.requests.peak_queued_chunks() <= QUEUED_CHUNKS_PER_STREAM,
            "at most 8 queued chunks"
        );
        harness.gate.set(true);
        assert_eq!(
            harness
                .exit(&call, Duration::from_secs(30))
                .expect("exit")
                .1["exitCode"],
            0
        );
        assert!(
            harness
                .output(&call, "stdout")
                .ends_with(&vec![b'o'; 4_194_304]),
            "every byte arrives after the queue drains"
        );
    }

    #[test]
    fn streamed_input_waits_for_input_written_and_never_blocks_the_service_pipe_reader() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let call = uuid();
        let mut body = run_body(
            &call,
            &operation,
            &workspace,
            &["slow-stdin", "2000"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        );
        body["inputBytes"] = json!(8 * CHUNK_BYTES);
        harness.send(body);
        let chunk = encode(&vec![b'i'; CHUNK_BYTES]);
        for _ in 0..QUEUED_CHUNKS_PER_STREAM {
            let start = Instant::now();
            harness.send(json!({ "type": "input", "callId": call, "data": chunk }));
            assert!(
                start.elapsed() < Duration::from_millis(200),
                "an input frame never blocks the reader"
            );
        }
        let count = uuid();
        harness.send(json!({ "type": "lingeringCount", "callId": count, "operationId": operation, "commonDirectory": workspace.worktree.join(".git") }));
        assert!(
            harness
                .wait_reply(Duration::from_secs(1), |v| v["callId"] == count)
                .is_some(),
            "other frames get answers while input waits"
        );
        let written = |h: &Harness| {
            h.replies_for(&call)
                .iter()
                .filter(|(_, v)| v["type"] == "inputWritten")
                .count()
        };
        assert!(
            eventually(WAIT, || written(&harness) == QUEUED_CHUNKS_PER_STREAM),
            "one inputWritten per written chunk"
        );
        assert_eq!(
            harness.output_line(&call, "stdout", "STDIN"),
            (8 * CHUNK_BYTES).to_string(),
            "the shell closes stdin at inputBytes"
        );
        assert_eq!(harness.exit(&call, WAIT).expect("exit").1["exitCode"], 0);
    }

    // ---- Cancel, exit replies, and lingering Jobs ----

    #[test]
    fn cancel_closes_only_the_job_of_that_operation_at_once_while_a_grandchild_sleeps() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let canceled = harness.run(&uuid(), &workspace, &["grandchild", "1", "60000", "stay"]);
        let other = harness.run(&uuid(), &workspace, &["sleep", "60000"]);
        let grandchild = Proc::open(
            harness
                .output_line(&canceled, "stdout", "GRANDCHILD")
                .parse()
                .expect("pid"),
        );
        let other_child = Proc::open(
            harness
                .output_line(&other, "stdout", "PID")
                .parse()
                .expect("pid"),
        );
        let start = Instant::now();
        harness.send(json!({ "type": "cancel", "callId": canceled }));
        let exit = harness
            .exit(&canceled, Duration::from_secs(2))
            .expect("exit at once");
        assert!(exit.0.duration_since(start) < Duration::from_secs(2));
        assert_eq!(
            exit.1["exitCode"],
            Value::Null,
            "a Job close ended the process"
        );
        assert!(
            grandchild.exits_within(CLOSE_BOUND),
            "the sleeping grandchild ends"
        );
        assert!(
            !other_child.exits_within(Duration::from_secs(1)),
            "the other operation keeps running"
        );
        assert!(harness.exit(&other, Duration::from_millis(10)).is_none());
    }

    #[test]
    fn the_exit_reply_carries_active_descendants_and_no_process_detail() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let lingering = harness.run(&uuid(), &workspace, &["grandchild", "1", "60000", "exit"]);
        let plain = harness.run(&uuid(), &workspace, &["sleep", "10"]);
        for (call, count) in [(&lingering, 1), (&plain, 0)] {
            let exit = harness.exit(call, WAIT).expect("exit").1;
            let keys: Vec<&String> = exit.as_object().expect("object").keys().collect();
            assert!(
                keys.iter().all(|k| [
                    "type",
                    "callId",
                    "exitCode",
                    "activeDescendants",
                    "deadline"
                ]
                .contains(&k.as_str())),
                "fields: {keys:?}"
            );
            assert_eq!(exit["exitCode"], 0);
            assert_eq!(exit["activeDescendants"], count);
        }
    }

    #[test]
    fn an_ended_frame_for_an_empty_job_closes_it() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let call = harness.run(&operation, &workspace, &["sleep", "10"]);
        harness.exit(&call, WAIT).expect("exit");
        harness.requests.ended(&operation, false);
        assert!(!harness.jobs.is_lingering(&operation));
        assert!(
            harness.jobs.job_handle(&operation).is_none(),
            "the empty Job closes"
        );
    }

    #[test]
    fn an_ended_frame_while_a_grandchild_sleeps_moves_the_job_to_the_lingering_set() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let call = harness.run(
            &operation,
            &workspace,
            &["grandchild", "1", "60000", "exit"],
        );
        let grandchild = Proc::open(
            harness
                .output_line(&call, "stdout", "GRANDCHILD")
                .parse()
                .expect("pid"),
        );
        harness.exit(&call, WAIT).expect("exit");
        harness.requests.ended(&operation, false);
        assert!(harness.jobs.is_lingering(&operation), "the Job lingers");
        assert!(
            !grandchild.exits_within(Duration::from_secs(1)),
            "the grandchild keeps running"
        );
    }

    #[test]
    fn a_service_exit_closes_every_operation_job_outside_the_lingering_set() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let lingering = uuid();
        let call = harness.run(
            &lingering,
            &workspace,
            &["grandchild", "1", "60000", "exit"],
        );
        let grandchild = Proc::open(
            harness
                .output_line(&call, "stdout", "GRANDCHILD")
                .parse()
                .expect("pid"),
        );
        harness.exit(&call, WAIT).expect("exit");
        harness.requests.ended(&lingering, false);
        let running = harness.run(&uuid(), &workspace, &["sleep", "60000"]);
        let child = Proc::open(
            harness
                .output_line(&running, "stdout", "PID")
                .parse()
                .expect("pid"),
        );
        harness.requests.service_exited();
        assert!(
            child.exits_within(CLOSE_BOUND),
            "the running operation Job closes"
        );
        assert!(
            !grandchild.exits_within(Duration::from_secs(1)),
            "the lingering Job stays"
        );
        assert!(harness.jobs.is_lingering(&lingering));
    }

    #[test]
    fn the_exit_reply_follows_the_child_exit_not_pipe_end_of_file() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let result = harness.fixture.path("late-writer.txt");
        let exit_file = harness.fixture.path("exit.txt");
        let operation = uuid();
        let mode = [
            "pipe-holder",
            "3000",
            "67108864",
            result.to_str().expect("path"),
            exit_file.to_str().expect("path"),
        ];
        let call = harness.run(&operation, &workspace, &mode);
        let (arrived, exit) = harness
            .exit(&call, WAIT)
            .expect("an exit reply before pipe end-of-file");
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_millis()
            - arrived.elapsed().as_millis();
        let child_exit: u128 = wait_file(&exit_file, "", WAIT)
            .and_then(|t| t.parse().ok())
            .expect("exit file");
        assert!(
            wall.saturating_sub(child_exit) < 1000,
            "the exit reply arrives within 1 s of the child exit"
        );
        assert_eq!(exit["exitCode"], 0, "discarded bytes count toward no cap");
        assert_eq!(
            exit["activeDescendants"], 1,
            "the grandchild holds the pipes"
        );
        let replies = harness.replies_for(&call);
        let last = replies
            .iter()
            .position(|(_, v)| v["type"] == "exit")
            .expect("exit");
        assert_eq!(last, replies.len() - 1, "the exit reply is the last reply");
        let stdout = String::from_utf8_lossy(&harness.output(&call, "stdout")).into_owned();
        let stderr = String::from_utf8_lossy(&harness.output(&call, "stderr")).into_owned();
        assert!(
            stdout.contains("BEFORE stdout") && stderr.contains("BEFORE stderr"),
            "every byte before the exit arrives before the exit reply"
        );
        let written = wait_file(&result, "", Duration::from_secs(120))
            .expect("the grandchild finishes its writes");
        assert!(
            written.starts_with("ok"),
            "the grandchild never blocks or fails on a write: {written}"
        );
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(
            harness.replies_for(&call).len(),
            replies.len(),
            "no byte after the exit is forwarded"
        );
        let late = |bytes: Vec<u8>| bytes.windows(64).any(|w| w.iter().all(|&b| b == b'g'));
        assert!(
            !late(harness.output(&call, "stdout")) && !late(harness.output(&call, "stderr")),
            "no grandchild byte is forwarded"
        );
        assert!(
            harness.requests.peak_queued_chunks() <= QUEUED_CHUNKS_PER_STREAM,
            "the shell queues none of the discarded bytes"
        );
        harness.send(json!({ "type": "closeJob", "operationId": operation }));
    }

    #[test]
    fn a_lingering_count_request_returns_the_tag_count_without_process_detail() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let common = workspace.worktree.join(".git");
        let operation = uuid();
        let call = harness.run(
            &operation,
            &workspace,
            &["grandchild", "2", "60000", "exit"],
        );
        harness
            .requests
            .tag(&operation, read_identity(&common).expect("identity"));
        harness.exit(&call, WAIT).expect("exit");
        harness.requests.ended(&operation, false);
        let count = uuid();
        harness.send(json!({ "type": "lingeringCount", "callId": count, "operationId": uuid(), "commonDirectory": common }));
        assert_eq!(
            harness.reply(&count),
            json!({ "type": "lingeringCount", "callId": count, "count": 2 })
        );
        let unreadable = uuid();
        harness.send(json!({ "type": "lingeringCount", "callId": unreadable, "operationId": uuid(), "commonDirectory": harness.fixture.path("absent") }));
        assert_eq!(
            harness.reply(&unreadable),
            json!({ "type": "lingeringCount", "callId": unreadable, "count": 0 })
        );
    }

    // ---- Identity requests ----

    fn junction(link: &Path, target: &Path) -> bool {
        Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn an_identity_request_returns_the_bootstrap_identity_and_follows_a_junction() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let target = workspace.worktree.join(".git");
        let link = harness.fixture.path("link");
        if !junction(&link, &target) {
            println!("SKIP: junction creation (mklink /J) failed");
            return;
        }
        let held = harness.fixture.path("held.txt");
        let _holder = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .share_mode(0)
                .open(&held)
                .expect("hold without sharing")
        };
        let call = uuid();
        harness.send(json!({
            "type": "identity", "callId": call, "operationId": uuid(), "contextKind": "registeredOperation",
            "gitInstallationId": workspace.git, "repositoryId": workspace.repository,
            "paths": [target, link, held, harness.fixture.path("absent")],
        }));
        let expected = read_identity(&target).expect("bootstrap identity").reply();
        let reply = harness.reply(&call);
        assert_eq!(reply["type"], "identity");
        let identities = reply["identities"].as_array().expect("identities");
        assert_eq!(identities.len(), 4, "one entry per path, in order");
        assert_eq!(identities[0], expected, "the bootstrap identity");
        assert_eq!(
            identities[1], expected,
            "a junction gives the identity of its target"
        );
        assert_eq!(
            identities[2],
            read_identity(&held).expect("identity").reply(),
            "attribute-only access opens a file held without sharing"
        );
        assert_eq!(
            identities[3],
            json!({ "code": "UNSUPPORTED_REPOSITORY" }),
            "a failed call"
        );
    }

    #[test]
    fn an_all_zero_or_all_ones_file_id_gives_unsupported_repository() {
        assert_eq!(
            Identity::checked(0x4474_2150_7421_4650, [0; 16]),
            Err("UNSUPPORTED_REPOSITORY"),
            "not supported"
        );
        assert_eq!(
            Identity::checked(0x4474_2150_7421_4650, [0xff; 16]),
            Err("UNSUPPORTED_REPOSITORY"),
            "cannot be established"
        );
        let mut id = [0u8; 16];
        id[0] = 1;
        assert_eq!(
            Identity::checked(7, id),
            Ok(Identity {
                volume_serial: 7,
                file_id: id
            })
        );
    }

    #[test]
    fn identity_requests_refuse_nine_paths_a_nul_and_an_overlong_path() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let at_limit = format!(r"C:\{}", "a".repeat(PATH_UNITS - 3));
        assert_eq!(at_limit.encode_utf16().count(), PATH_UNITS);
        let above = format!("{at_limit}a");
        for (name, paths, refused_code) in [
            (
                "nine paths",
                json!(vec![workspace.worktree.clone(); IDENTITY_PATHS + 1]),
                true,
            ),
            (
                "a path with NUL",
                json!([format!("{}\u{0}x", workspace.worktree.display())]),
                true,
            ),
            ("a path above 32,767 units", json!([above]), true),
            (
                "eight paths",
                json!(vec![workspace.worktree.clone(); IDENTITY_PATHS]),
                false,
            ),
        ] {
            let call = uuid();
            harness.send(json!({
                "type": "identity", "callId": call, "operationId": uuid(), "contextKind": "registeredOperation",
                "gitInstallationId": workspace.git, "repositoryId": workspace.repository, "paths": paths,
            }));
            let reply = harness.reply(&call);
            if refused_code {
                assert_eq!(reply, refused(&call, "INVALID_REQUEST"), "{name}");
            } else {
                assert_eq!(
                    reply["identities"].as_array().map(Vec::len),
                    Some(IDENTITY_PATHS),
                    "{name}"
                );
            }
        }
    }

    // ---- Terminal input and console variants (contract §6 "Console and input", plan.md F11, research.md R14 S17) ----

    fn search_path(name: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    }

    fn find_git() -> Option<PathBuf> {
        let found = std::env::var_os("ARBARETO_TEST_GIT")
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .or_else(|| search_path("git.exe"));
        match &found {
            Some(git) => println!("GIT {}", git.display()),
            None => println!("SKIP: Git executable absent"),
        }
        found
    }

    fn find_program(name: &str, system: &str) -> Option<PathBuf> {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let found = Some(root.join(system))
            .filter(|p| p.is_file())
            .or_else(|| search_path(name));
        if found.is_none() {
            println!("SKIP: {name} absent");
        }
        found
    }

    /// The service environment of the Git tests. HOME and the global configuration point into the owned fixture.
    fn owned_environment(home: &Path) -> Vec<(OsString, OsString)> {
        let redirected = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "EMAIL"];
        let mut environment: Vec<(OsString, OsString)> = std::env::vars_os()
            .filter(|(k, _)| {
                let name = k.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("GIT_") && !redirected.contains(&name.as_str())
            })
            .collect();
        for (k, v) in [
            ("HOME", home.to_path_buf()),
            ("USERPROFILE", home.to_path_buf()),
            ("XDG_CONFIG_HOME", home.join(".config")),
            ("GIT_CONFIG_GLOBAL", home.join(".gitconfig")),
            ("GIT_CONFIG_NOSYSTEM", PathBuf::from("1")),
        ] {
            environment.push((OsString::from(k), v.into_os_string()));
        }
        environment
    }

    /// Runs a fixture command with a bound. Returns its exit status and output.
    fn run_fixture(command: &mut Command, timeout: Duration) -> (i32, String) {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn fixture command");
        let mut stdout = child.stdout.take().expect("stdout");
        let mut stderr = child.stderr.take().expect("stderr");
        let out = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stdout.read_to_string(&mut text);
            text
        });
        let err = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = child.try_wait().expect("try_wait") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("fixture command exceeded {timeout:?}: {command:?}");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        (
            status.code().unwrap_or(-1),
            format!(
                "{}{}",
                out.join().unwrap_or_default(),
                err.join().unwrap_or_default()
            ),
        )
    }

    struct GitFixture {
        harness: Harness,
        git: PathBuf,
        environment: Vec<(OsString, OsString)>,
        repository: PathBuf,
        workspace: Workspace,
    }

    impl GitFixture {
        /// Builds an owned repository with one staged file and the `pre-commit` hook that `hook` writes.
        fn new(git: PathBuf, hook: impl FnOnce(&Fixture) -> String) -> GitFixture {
            let fixture = Fixture::new();
            let home = fixture.path("home");
            let environment = owned_environment(&home);
            let harness = Harness::new(fixture, Vec::new(), environment.clone());
            let hook = hook(&harness.fixture);
            std::fs::create_dir_all(home.join(".config")).expect("home");
            std::fs::write(
                home.join(".gitconfig"),
                "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[credential]\n\thelper =\n",
            )
            .expect("global configuration");
            let repository = harness.fixture.path("repo");
            std::fs::create_dir(&repository).expect("repository folder");
            let fixture_git = |args: &[&str]| {
                let mut command = Command::new(&git);
                command
                    .args(args)
                    .current_dir(&repository)
                    .env_clear()
                    .envs(environment.iter().map(|(k, v)| (k, v)));
                run_fixture(&mut command, WAIT)
            };
            assert_eq!(fixture_git(&["init", "--quiet"]).0, 0, "git init");
            std::fs::write(repository.join("a.txt"), "a\n").expect("file");
            assert_eq!(fixture_git(&["add", "a.txt"]).0, 0, "git add");
            std::fs::write(
                repository.join(".git").join("hooks").join("pre-commit"),
                &hook,
            )
            .expect("hook");
            let git_id = harness.register_git(&git);
            let repository_id = harness.register_repository(&git_id, &repository);
            let workspace = Workspace {
                git: git_id,
                repository: repository_id,
                worktree: repository.clone(),
            };
            GitFixture {
                harness,
                git,
                environment,
                repository,
                workspace,
            }
        }

        fn commit(&self, operation: &str, deadline_ms: u64) -> String {
            let call = uuid();
            let mut body = run_body(
                &call,
                operation,
                &self.workspace,
                &["commit", "--quiet", "--file=-"],
                "mutation",
                json!({ "deadlineMs": deadline_ms, "stallMs": STALL_MS }),
            );
            body["input"] = json!(encode(b"Fixture commit\n"));
            self.harness.send(body);
            call
        }

        fn no_commit_exists(&self) -> bool {
            let mut command = Command::new(&self.git);
            command
                .args(["rev-parse", "--verify", "-q", "HEAD"])
                .current_dir(&self.repository)
                .env_clear()
                .envs(self.environment.iter().map(|(k, v)| (k, v)));
            run_fixture(&mut command, WAIT).0 != 0
        }
    }

    fn sh_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    /// A commit whose hook waits on input ends with a non-zero exit within 10 s. No commit exists.
    fn assert_hook_fails_fast(variant: &str, wait: &str) {
        let Some(git) = find_git() else { return };
        let fixture = GitFixture::new(git, |_| {
            format!("#!/bin/sh\necho \"HOOK {variant}\" >&2\n{wait}\n")
        });
        let start = Instant::now();
        let call = fixture.commit(&uuid(), REGISTERED_DEADLINE_MS);
        let (arrived, exit) = fixture
            .harness
            .exit(&call, Duration::from_secs(10))
            .unwrap_or_else(|| panic!("{variant}: no exit within 10 s"));
        println!(
            "OBSERVATION T027: {variant} hook commit ended after {} ms",
            arrived.duration_since(start).as_millis()
        );
        assert!(
            exit["exitCode"].as_u64().is_some_and(|code| code != 0),
            "{variant}: a non-zero exit code: {exit}"
        );
        assert!(
            String::from_utf8_lossy(&fixture.harness.output(&call, "stderr"))
                .contains(&format!("HOOK {variant}")),
            "{variant}: the hook output reaches stderr"
        );
        assert!(fixture.no_commit_exists(), "{variant}: no commit exists");
    }

    #[test]
    fn a_hook_that_reads_the_terminal_fails_the_commit_within_10_seconds() {
        assert_hook_fails_fast("tty", "read -r line < /dev/tty");
    }

    #[test]
    fn a_hook_that_asks_for_credentials_fails_the_commit_within_10_seconds() {
        assert_hook_fails_fast(
            "credential",
            "printf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill",
        );
    }

    #[test]
    fn a_hook_that_sleeps_20_seconds_proves_that_the_10_second_bound_can_fail() {
        let Some(git) = find_git() else { return };
        let fixture = GitFixture::new(git, |_| {
            "#!/bin/sh\necho \"HOOK sleep\" >&2\nsleep 20\n".to_string()
        });
        let call = fixture.commit(&uuid(), REGISTERED_DEADLINE_MS);
        assert!(
            fixture
                .harness
                .exit(&call, Duration::from_secs(10))
                .is_none(),
            "the control hook is still running after 10 s"
        );
        fixture
            .harness
            .send(json!({ "type": "cancel", "callId": call }));
        assert_eq!(
            fixture
                .harness
                .exit(&call, CLOSE_BOUND)
                .expect("cancel ends the control")
                .1["exitCode"],
            Value::Null
        );
        assert!(fixture.no_commit_exists());
    }

    /// A commit whose hook waits on a hidden console ends at a 5-second deadline with every descendant.
    fn assert_console_wait_ends_at_the_deadline(
        variant: &str,
        hook_line: impl FnOnce(&Fixture) -> String,
    ) {
        let Some(git) = find_git() else { return };
        let fixture = GitFixture::new(git, |root| {
            format!(
                "#!/bin/sh\necho \"HOOK {variant}\" >&2\n{}\n",
                hook_line(root)
            )
        });
        let operation = uuid();
        let start = Instant::now();
        let call = fixture.commit(&operation, 5_000);
        std::thread::sleep(Duration::from_secs(3));
        let processes: Vec<Proc> = fixture
            .harness
            .jobs
            .process_ids(&operation)
            .into_iter()
            .filter_map(Proc::try_open)
            .collect();
        assert!(
            !processes.is_empty(),
            "{variant}: the Job holds the commit processes"
        );
        let (arrived, exit) = fixture
            .harness
            .exit(&call, Duration::from_secs(10))
            .expect("exit at the deadline");
        let elapsed = arrived.duration_since(start);
        println!(
            "OBSERVATION T027: {variant} console wait ended after {} ms",
            elapsed.as_millis()
        );
        assert!(
            elapsed >= Duration::from_millis(4_500) && elapsed < Duration::from_secs(8),
            "{variant}: the commit ends at the deadline"
        );
        assert_eq!(exit["deadline"], "deadline", "{variant}");
        assert_eq!(
            exit["exitCode"],
            Value::Null,
            "{variant}: the Job close ended the commit"
        );
        for process in &processes {
            assert!(
                process.exits_within(Duration::from_secs(1)),
                "{variant}: process {} remains",
                process.pid
            );
        }
        assert!(fixture.no_commit_exists(), "{variant}: no commit exists");
    }

    #[test]
    fn a_hook_that_reads_a_secure_console_string_ends_at_the_commit_deadline() {
        let Some(powershell) = find_program(
            "powershell.exe",
            r"System32\WindowsPowerShell\v1.0\powershell.exe",
        ) else {
            return;
        };
        assert_console_wait_ends_at_the_deadline("powershell", |_| {
            format!(
                "'{}' -NoProfile -Command \"Read-Host -AsSecureString x\"",
                sh_path(&powershell)
            )
        });
    }

    #[test]
    fn a_hook_that_waits_for_an_ssh_key_passphrase_ends_at_the_commit_deadline() {
        let Some(keygen) = find_program("ssh-keygen.exe", r"System32\OpenSSH\ssh-keygen.exe")
        else {
            return;
        };
        assert_console_wait_ends_at_the_deadline("ssh-keygen", |root| {
            let key = root.path("key");
            let mut command = Command::new(&keygen);
            command
                .args([
                    "-q",
                    "-t",
                    "ed25519",
                    "-N",
                    "arbareto-passphrase",
                    "-C",
                    "fixture",
                    "-f",
                ])
                .arg(&key);
            assert_eq!(
                run_fixture(&mut command, WAIT).0,
                0,
                "generate a passphrase key under the owned root"
            );
            format!("'{}' -y -f '{}'", sh_path(&keygen), sh_path(&key))
        });
    }
}
