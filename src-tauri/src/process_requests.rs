// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::IO::CancelSynchronousIo;
use windows::Win32::System::Pipes::PeekNamedPipe;
use windows::Win32::System::Threading::{
    CreateEventW, GetExitCodeProcess, SetEvent, WaitForSingleObject,
};

use crate::bootstrap::{
    ContextIdentity, ContextKind, Contexts, Identity, PhysicalIdentity, identity_reply,
    native_identity, read_identity,
};
use crate::dialogs::Registered;
use crate::file_facts;
use crate::git_env::child_environment;
use crate::jobs::Supervisor;
use crate::schema;
use crate::settings::{SavedWslGit, is_hex};
use crate::spawn::{Input, SpawnRequest, command_line, spawn};
use crate::wsl;

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
pub const REGISTERED_DEADLINE_MS: u64 = 120_000;
pub const STALL_MS: u64 = 15_000;
/// Contract §5 "Walk deadline": each `identity` and `fileFacts` request.
pub const WALK_DEADLINE_MS: u64 = 30_000;
/// Contract §6 "Context rules": `register` field `version` is printable ASCII.
pub const VERSION_BYTES: usize = 64;
/// Contract §5 "JSON nesting".
const JSON_NESTING_LEVELS: usize = 16;
/// Contract §6 "Channel frames" `indexFile`.
const CANDIDATE_PREFIX: &str = "arbareto-candidate-";
/// The ended operation IDs that the shell keeps (contract §5 "Finished operation records" count).
/// A request for an older ended ID passes the active check.
const INACTIVE_OPERATIONS: usize = 256;
/// The wait for a process handle after the shell closes its Job.
const CLOSE_WAIT: Duration = Duration::from_secs(5);
// ponytail: a silent child costs one pipe peek per stream every 10 ms. Blocking reads with CancelSynchronousIo remove it if T167 measures the wakeups.
const POLL: Duration = Duration::from_millis(10);

const INVALID: &str = "INVALID_REQUEST";
const UNKNOWN: &str = "UNKNOWN_TARGET";
const OWNERSHIP: &str = "PROCESS_OWNERSHIP_FAILED";

pub(crate) type Code = &'static str;
pub(crate) type Fields = Map<String, Value>;

/// Writes one frame body to the service. A queued chunk leaves its queue when this call returns.
pub type ReplySink = Arc<dyn Fn(String) + Send + Sync>;

/// Shows the Git selection confirmation for the selected path, the probed path, and the version (contract §3 "Git proposal").
pub type GitConfirmation = Box<dyn Fn(&Path, &Path, &str) -> Registered + Send + Sync>;

/// A Git that the user approved with Use this Git, or that a startup context registered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmedGit {
    pub selected_path: PathBuf,
    pub executable_path: PathBuf,
    pub version: String,
    /// The SHA-256 of `executable_path` that the service sent with `register`.
    pub digest: String,
}

/// Saves the Git that a startup context registered without Use this Git (contract §6 "Startup contexts").
pub type StartupGit = Box<dyn Fn(ConfirmedGit) + Send + Sync>;

/// Reads the approved WSL Git of each distro GUID from the native settings (contract §11 "Git per distro").
pub type WslSaved = Box<dyn Fn() -> Vec<SavedWslGit> + Send + Sync>;

/// Shows the WSL Git confirmation with the distro, the Git path, and the version (contract §11 "Git per distro").
/// True only for Use this Git.
pub type WslConfirmation = Box<dyn Fn(&str, &str, &str) -> bool + Send + Sync>;

/// Saves the WSL Git that Use this Git approved, for its distro GUID.
pub type WslStore = Box<dyn Fn(SavedWslGit) + Send + Sync>;

/// Makes the host of the WSL processes of one operation. Without it, they run in the operation Job. Tests inject them.
pub type WslHosts = Box<dyn Fn(&str) -> Box<dyn wsl::Host + Send> + Send + Sync>;

pub struct Config {
    /// The application-owned launch directory of a `gitProbe` run (contract §6 "Channel frames").
    pub launch_directory: PathBuf,
    /// `git_env` builds each child environment from this environment.
    pub base_environment: Vec<(OsString, OsString)>,
    /// Arguments before the request arguments at the `CreateProcessW` boundary, after validation.
    /// The product passes none. Tests pass the libtest arguments that re-execute the test binary.
    pub argument_prefix: Vec<String>,
    /// The product passes `WALK_DEADLINE_MS`. Tests pass a shorter deadline.
    pub walk_deadline: Duration,
}

/// The Git that `register` bound to a `gitInstallationId`.
enum Git {
    Windows {
        program: PathBuf,
        identity: Identity,
    },
    /// gaps.md W1: the shell compares a WSL Git identity only at `wslProbe`, so no `FileIdInfo` read runs for it.
    Wsl(wsl::Installation),
}

struct Repository {
    worktree_root: PathBuf,
    git_directory: PathBuf,
    common_directory: PathBuf,
    /// A WSL identity read of a stored path runs with this Git (gaps.md W2).
    git_installation_id: String,
}

/// Streamed input of one call (contract §6 "Streamed input").
struct Streamed {
    chunks: mpsc::Sender<Vec<u8>>,
    declared: u64,
    sent: u64,
    unacknowledged: Arc<AtomicUsize>,
}

struct Call {
    operation_id: String,
    streamed: Option<Streamed>,
    /// A Job close after the start of this call ended its process, so `exit` carries `exitCode` null.
    closed: bool,
}

/// The first event decides the reply of a walk (contract §6 "Walks").
enum WalkEvent {
    Done(Value),
    Stop,
}

/// A walk until its watchdog takes the first event.
struct Walk {
    operation_id: String,
    events: mpsc::Sender<WalkEvent>,
}

/// The stop of one walk (contract §6 "Walks"). A Windows walk reads `flag`. A WSL walk waits on the manual-reset `event` with its `wsl.exe`.
struct WalkStop {
    flag: AtomicBool,
    event: Owned,
}

// SAFETY: an Event is a kernel handle that any thread can set and wait on. `WalkStop` only reads it.
unsafe impl Sync for WalkStop {}

impl WalkStop {
    fn new() -> Option<WalkStop> {
        // SAFETY: a manual-reset event without a name and without security attributes.
        let event = unsafe { CreateEventW(None, true, false, None) }.ok()?;
        Some(WalkStop {
            flag: AtomicBool::new(false),
            event: Owned(event),
        })
    }
}

/// Ends a walk thread, also at a panic. The count drops first. Then the watchdog gets `Done`, or `Stop` without a reply.
struct WalkEnd {
    me: Arc<ProcessRequests>,
    events: mpsc::Sender<WalkEvent>,
    reply: Option<Value>,
}

impl Drop for WalkEnd {
    fn drop(&mut self) {
        self.me.walk_threads.fetch_sub(1, Ordering::SeqCst);
        let event = self.reply.take().map_or(WalkEvent::Stop, WalkEvent::Done);
        let _ = self.events.send(event);
    }
}

#[derive(Default)]
struct State {
    /// Operations after `ended` or `closeJob`, oldest first. Every other operation is active from its first request.
    inactive: VecDeque<String>,
    /// The first `operationId` of a `bootstrapId` owns it (contract §6 "Context rules").
    owners: HashMap<String, String>,
    gits: HashMap<String, Git>,
    repositories: HashMap<String, Repository>,
    /// Bound and released IDs. A released ID never binds again.
    issued: HashSet<String>,
    /// Each Git that the user approved with Use this Git, by `gitInstallationId`.
    confirmed: HashMap<String, ConfirmedGit>,
    calls: HashMap<String, Call>,
    /// `run` calls and walks share one `callId` namespace.
    walks: HashMap<String, Walk>,
    /// The mutations whose `started` reply carried a marker ID, until `ended`.
    started: HashSet<String>,
    /// The facts that `wslProbe` bound to each WSL `repositoryDiscovery` context, once (gaps.md W1).
    wsl_bound: HashMap<String, wsl::Bound>,
    /// The contexts with a `wslProbe` in flight. The reservation makes the bind happen once.
    wsl_probing: HashSet<String>,
    /// The last unit number of each operation with a WSL process (contract §11 "Process launch").
    wsl_units: HashMap<String, u32>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Bootstrap(ContextKind),
    Registered,
}

/// The native selection that a request runs against.
struct Target {
    program: PathBuf,
    current_dir: PathBuf,
    bootstrap_id: Option<String>,
    /// `None` for a probe, whose context identity is the executable identity.
    git_identity: Option<Identity>,
    git_directory: Option<PathBuf>,
    /// A WSL Git, and the Linux form of `current_dir` (contract §11 "Paths and file access").
    wsl: Option<(wsl::Installation, String)>,
}

enum RunInput {
    Closed,
    Bytes(Vec<u8>),
    Streamed(u64),
}

/// The two output pipes of one run and the budget that the completion signal sets (contract §6 "Completion signal").
struct Run {
    call_id: String,
    operation_id: String,
    generation: u64,
    pipes: [File; 2],
    state: Mutex<Drain>,
    changed: Condvar,
    /// True after `watch` removed the call. The input writer holds this lock while it sends `inputWritten`.
    exited: Arc<Mutex<bool>>,
}

#[derive(Default)]
struct Drain {
    /// The bytes that a stream may still forward. `None` until the completion signal.
    budget: [Option<u64>; 2],
    /// The stream forwarded its budget or reached end-of-file.
    done: [bool; 2],
}

const STREAMS: [&str; 2] = ["stdout", "stderr"];

/// The shell side of the private `process` channel (contract §6 "Channel frames").
pub struct ProcessRequests {
    me: Weak<ProcessRequests>,
    config: Config,
    contexts: Arc<Contexts>,
    jobs: Arc<Supervisor>,
    sink: ReplySink,
    state: Mutex<State>,
    /// A service exit starts a new generation. Replies of an older generation are dropped.
    generation: AtomicU64,
    peak: AtomicUsize,
    /// The walks whose work did not return yet.
    walk_threads: AtomicUsize,
    /// Without it, a `register` with `confirm: true` gets `declined`.
    git_confirmation: OnceLock<GitConfirmation>,
    startup_git: OnceLock<StartupGit>,
    /// Without it, a `wslDistros` reply holds no saved Git.
    wsl_saved: OnceLock<WslSaved>,
    /// Without it, a WSL `register` gets `declined`.
    wsl_confirmation: OnceLock<WslConfirmation>,
    wsl_store: OnceLock<WslStore>,
    wsl_hosts: OnceLock<WslHosts>,
}

impl ProcessRequests {
    pub fn new(
        config: Config,
        contexts: Arc<Contexts>,
        jobs: Arc<Supervisor>,
        sink: ReplySink,
    ) -> Arc<ProcessRequests> {
        Arc::new_cyclic(|me| ProcessRequests {
            me: me.clone(),
            config,
            contexts,
            jobs,
            sink,
            state: Mutex::new(State::default()),
            generation: AtomicU64::new(0),
            peak: AtomicUsize::new(0),
            walk_threads: AtomicUsize::new(0),
            git_confirmation: OnceLock::new(),
            startup_git: OnceLock::new(),
            wsl_saved: OnceLock::new(),
            wsl_confirmation: OnceLock::new(),
            wsl_store: OnceLock::new(),
            wsl_hosts: OnceLock::new(),
        })
    }

    pub fn set_git_confirmation(&self, confirmation: GitConfirmation) {
        let _ = self.git_confirmation.set(confirmation);
    }

    pub fn set_startup_git(&self, save: StartupGit) {
        let _ = self.startup_git.set(save);
    }

    pub fn set_wsl_saved(&self, saved: WslSaved) {
        let _ = self.wsl_saved.set(saved);
    }

    pub fn set_wsl_confirmation(&self, confirmation: WslConfirmation) {
        let _ = self.wsl_confirmation.set(confirmation);
    }

    pub fn set_wsl_store(&self, store: WslStore) {
        let _ = self.wsl_store.set(store);
    }

    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only tests inject the WSL host")
    )]
    pub fn set_wsl_hosts(&self, hosts: WslHosts) {
        let _ = self.wsl_hosts.set(hosts);
    }

    /// The host of the WSL processes of an operation. The caller opened its Job.
    fn wsl_host(&self, operation_id: &str) -> Box<dyn wsl::Host + Send> {
        match self.wsl_hosts.get() {
            Some(hosts) => hosts(operation_id),
            None => Box::new(wsl::OperationHost {
                jobs: Arc::clone(&self.jobs),
                operation_id: operation_id.to_string(),
                current_dir: self.config.launch_directory.clone(),
            }),
        }
    }

    /// The identity of a frame path that the shell reads for its own frames (gaps.md W2).
    /// A WSL path reads through the identity probe of the registered repository whose stored path equals it.
    pub fn read_physical_identity(&self, path: &Path) -> Option<PhysicalIdentity> {
        if !file_facts::is_wsl_path(path) {
            return native_identity(path);
        }
        let installation = {
            let state = self.state();
            let repository = state.repositories.values().find(|r| {
                [&r.worktree_root, &r.git_directory, &r.common_directory]
                    .iter()
                    .any(|stored| stored.as_path() == path)
            })?;
            match state.gits.get(&repository.git_installation_id)? {
                Git::Wsl(installation) => installation.clone(),
                Git::Windows { .. } => return None,
            }
        };
        let linux = wsl::linux_path(path, &installation.distro)?;
        // An internal operation owns the Job of the probe.
        let operation = crate::settings::random_id().ok()?;
        self.jobs.open(&operation).ok()?;
        let found = wsl::identities(
            &*self.wsl_host(&operation),
            &installation,
            &operation,
            1,
            &[linux],
            &self.config.base_environment,
            None,
        );
        self.jobs.close(&operation);
        found.into_iter().next()?.ok().map(PhysicalIdentity::Wsl)
    }

    /// The next unit number of a WSL process of the operation (contract §11 "Process launch").
    fn next_unit(state: &mut State, operation_id: &str) -> u32 {
        let n = state.wsl_units.entry(operation_id.to_string()).or_insert(0);
        *n += 1;
        *n
    }

    /// The Git that Use this Git approved for `git_id`. Each approval is taken once.
    pub fn take_confirmed_git(&self, git_id: &str) -> Option<ConfirmedGit> {
        self.state().confirmed.remove(git_id)
    }

    /// Handles one `process` frame body. It never waits on a child pipe.
    pub fn handle(&self, body: &str) {
        let Some(frame) = decode_strict(body) else {
            return;
        };
        let Some(request) = frame.get("process").and_then(Value::as_object) else {
            return;
        };
        let call_id = request
            .get("callId")
            .and_then(Value::as_str)
            .filter(|id| is_identifier(id));
        let shaped = frame.as_object().is_some_and(|f| f.len() == 2)
            && frame.get("kind").and_then(Value::as_str) == Some("process");
        let result = if shaped {
            self.dispatch(request, call_id)
        } else {
            Err(INVALID)
        };
        if let (Err(code), Some(call_id)) = (result, call_id) {
            self.send(
                self.current(),
                json!({ "type": "refused", "callId": call_id, "code": code }),
            );
        }
    }

    /// Records a `started` reply with a marker ID, and tags the Job of that mutation with the common-directory identity.
    /// `started` comes before the first process, so the Job opens here (contract §6 "Recovery markers").
    pub fn tag(&self, operation_id: &str, common_identity: PhysicalIdentity) {
        self.state().started.insert(operation_id.to_string());
        if self.jobs.open(operation_id).is_ok() {
            self.jobs.tag(operation_id, common_identity);
        }
    }

    /// Handles the `mutation` frame `ended` (contract §6 "Lingering Jobs").
    pub fn ended(&self, operation_id: &str, end_processes: bool) -> Result<(), Code> {
        let mut state = self.state();
        // Contract §6: `ended` comes only after a `started` reply with a marker ID. Read Jobs never linger.
        if !state.started.remove(operation_id) {
            return Err(INVALID);
        }
        if end_processes {
            mark_closed(&mut state, operation_id);
        }
        self.jobs.ended(operation_id, end_processes);
        deactivate(&mut state, operation_id);
        Ok(())
    }

    /// Drops every pending call, and closes every operation Job outside the lingering set.
    pub fn service_exited(&self) {
        let mut state = self.state();
        for walk in state.walks.values() {
            let _ = walk.events.send(WalkEvent::Stop);
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.jobs.service_exited();
        *state = State::default();
    }

    /// Test hook: the largest number of chunks that one stream queue held.
    #[cfg_attr(not(test), expect(dead_code, reason = "test hook"))]
    pub fn peak_queued_chunks(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }

    /// Test hook: the walks whose work did not return yet.
    #[cfg_attr(not(test), expect(dead_code, reason = "test hook"))]
    pub fn active_walks(&self) -> usize {
        self.walk_threads.load(Ordering::SeqCst)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn send(&self, generation: u64, reply: Value) {
        if generation == self.current() {
            (self.sink)(json!({ "kind": "process", "process": reply }).to_string());
        }
    }

    fn dispatch(&self, request: &Fields, call_id: Option<&str>) -> Result<(), Code> {
        let call = || call_id.ok_or(INVALID);
        match request.get("type").and_then(Value::as_str) {
            Some("run") => self.run(request, call()?),
            Some("input") => self.input(request),
            Some("cancel") => self.cancel(request),
            Some("identity") => self.identity(request, call()?),
            Some("fileFacts") => self.file_facts(request, call()?),
            Some("lingeringCount") => self.lingering_count(request, call()?),
            Some("register") => self.register(request, call()?),
            Some("resolveGit") => self.resolve_git(request, call()?),
            Some("release") => self.release(request),
            Some("closeJob") => self.close_job(request),
            Some("wslDistros") => self.wsl_distros(request, call()?),
            Some("wslProbe") => self.wsl_probe(request, call()?),
            _ => Err(INVALID),
        }
    }

    fn run(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        keys(
            request,
            &[
                "type",
                "callId",
                "operationId",
                "contextKind",
                "arguments",
                "environmentPolicy",
                "limits",
            ],
            &[
                "bootstrapId",
                "gitInstallationId",
                "repositoryId",
                "input",
                "inputBytes",
                "transactionId",
                "indexFile",
            ],
        )?;
        let operation_id = identifier(&request["operationId"])?;
        let kind = context_kind(request)?;
        let arguments: Vec<String> = request["arguments"]
            .as_array()
            .ok_or(INVALID)?
            .iter()
            .map(|a| a.as_str().filter(|a| !a.contains('\0')).map(str::to_string))
            .collect::<Option<_>>()
            .ok_or(INVALID)?;
        let policy = request["environmentPolicy"].as_str().ok_or(INVALID)?;
        // `network` waits for its inactivity and ceiling limits (T228).
        let policy_fits = match kind {
            Kind::Bootstrap(_) => policy == "probe",
            Kind::Registered => matches!(policy, "read" | "mutation"),
        };
        if !policy_fits {
            return Err(INVALID);
        }
        if kind == Kind::Registered
            && arguments.first().map(String::as_str) != Some("--no-lazy-fetch")
        {
            return Err(INVALID);
        }
        let limit = deadline(&request["limits"], kind)?;
        let input = match (request.get("input"), request.get("inputBytes")) {
            (None, None) => RunInput::Closed,
            (Some(data), None) => RunInput::Bytes(chunk(data, INLINE_INPUT_BYTES)?),
            (None, Some(total)) => RunInput::Streamed(count(total, 1, STREAMED_INPUT_BYTES)?),
            _ => return Err(INVALID),
        };
        let index_file = match (request.get("transactionId"), request.get("indexFile")) {
            (None, None) => None,
            (Some(transaction), Some(file)) if policy == "mutation" => {
                identifier(transaction)?;
                Some(path(file)?)
            }
            _ => return Err(INVALID),
        };

        let mut state = self.state();
        if state.calls.contains_key(call_id) || state.walks.contains_key(call_id) {
            return Err(INVALID);
        }
        check_active(&state, operation_id)?;
        // The marker and the mutex exist before the first side effect (contract §6 "Recovery markers").
        if policy == "mutation" && !state.started.contains(operation_id) {
            return Err(INVALID);
        }
        let target = self.target(&mut state, request, kind, operation_id)?;
        if let Some(file) = &index_file {
            let named = file
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(CANDIDATE_PREFIX));
            if !named || file.parent() != target.git_directory.as_deref() {
                return Err(INVALID);
            }
        }
        let now = Instant::now();
        if let Some(bootstrap_id) = &target.bootstrap_id {
            self.contexts.permits(bootstrap_id, &arguments, now)?;
        }
        // Contract §11 "Process launch": a WSL Git runs through the wrapper, and `-C` takes the Linux directory.
        let (wsl_command, full, environment) = match &target.wsl {
            Some((installation, directory)) => {
                let command = self.wsl_run_command(
                    &mut state,
                    operation_id,
                    installation,
                    directory,
                    policy,
                    index_file.as_deref(),
                    &arguments,
                    &input,
                )?;
                (Some(command), Vec::new(), Vec::new())
            }
            None => {
                let mut full = self.config.argument_prefix.clone();
                full.extend(arguments);
                let environment = child_environment(
                    policy,
                    &self.config.base_environment,
                    index_file.as_deref(),
                )?;
                (None, full, environment)
            }
        };
        match &wsl_command {
            Some(command) => command_line(&command.program, &command.arguments),
            None => command_line(&target.program, &full),
        }
        .map_err(|_| INVALID)?;
        self.revalidate(&target, now)?;

        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        self.jobs.open(operation_id).map_err(|_| OWNERSHIP)?;
        let spawned = match (&target.wsl, &wsl_command) {
            (Some((installation, _)), Some(command)) => {
                let host = self.wsl_host(operation_id);
                // Contract §11 "Process ownership": a WSL mutation starts its anchor before its first Git process.
                if policy == "mutation" {
                    let anchor = wsl::anchor_command(
                        installation,
                        operation_id,
                        &self.config.base_environment,
                    )?;
                    host.anchor(&anchor).map_err(|_| OWNERSHIP)?;
                }
                host.start(command).map_err(|_| OWNERSHIP)?
            }
            _ => {
                let request = SpawnRequest {
                    program: &target.program,
                    arguments: &full,
                    environment: &environment,
                    current_dir: &target.current_dir,
                    wsl: false,
                    input: match &input {
                        RunInput::Closed => Input::Closed,
                        RunInput::Bytes(bytes) => Input::Bytes(bytes),
                        RunInput::Streamed(_) => Input::Stream,
                    },
                };
                self.jobs
                    .with_job(operation_id, |job| spawn(&request, job))
                    .map_err(|_| OWNERSHIP)?
                    .map_err(|_| OWNERSHIP)?
            }
        };

        let generation = self.current();
        let exited = Arc::new(Mutex::new(false));
        let streamed = match (input, spawned.stdin) {
            (RunInput::Streamed(declared), Some(stdin)) => Some(Arc::clone(&me).write_input(
                call_id,
                generation,
                declared,
                stdin,
                Arc::clone(&exited),
            )),
            _ => None,
        };
        state.calls.insert(
            call_id.to_string(),
            Call {
                operation_id: operation_id.to_string(),
                streamed,
                closed: false,
            },
        );
        drop(state);

        let run = Arc::new(Run {
            call_id: call_id.to_string(),
            operation_id: operation_id.to_string(),
            generation,
            pipes: [spawned.stdout, spawned.stderr],
            state: Mutex::new(Drain::default()),
            changed: Condvar::new(),
            exited,
        });
        for stream in 0..2 {
            let (me, run) = (Arc::clone(&me), Arc::clone(&run));
            std::thread::spawn(move || me.read_stream(&run, stream));
        }
        let process = Owned(spawned.process);
        std::thread::spawn(move || me.watch(&run, process, limit));
        Ok(())
    }

    /// Resolves the context IDs of a `run` or `identity` request (contract §6 "Context rules").
    fn target(
        &self,
        state: &mut State,
        request: &Fields,
        kind: Kind,
        operation_id: &str,
    ) -> Result<Target, Code> {
        let now = Instant::now();
        let git = |state: &State| -> Result<Result<(PathBuf, Identity), wsl::Installation>, Code> {
            let id = request["gitInstallationId"].as_str().ok_or(INVALID)?;
            Ok(match state.gits.get(id).ok_or(UNKNOWN)? {
                Git::Windows { program, identity } => Ok((program.clone(), *identity)),
                Git::Wsl(installation) => Err(installation.clone()),
            })
        };
        match kind {
            Kind::Bootstrap(context_kind) => {
                let bootstrap_id = request["bootstrapId"].as_str().ok_or(INVALID)?;
                let context = self.contexts.get(bootstrap_id, now)?;
                if context.kind != context_kind {
                    return Err(UNKNOWN);
                }
                own(state, &self.contexts, bootstrap_id, operation_id, now)?;
                let (program, git_identity, current_dir, wsl) = match context_kind {
                    ContextKind::GitProbe => (
                        context.path,
                        None,
                        self.config.launch_directory.clone(),
                        None,
                    ),
                    // gaps.md W1: a WSL context runs only the WSL Git of its bound GUID, and a Windows context only a Windows Git.
                    ContextKind::RepositoryDiscovery => match (git(state)?, context.identity) {
                        (Ok((program, identity)), ContextIdentity::Windows(_)) => {
                            (program, Some(identity), context.path, None)
                        }
                        (Err(installation), ContextIdentity::Wsl) => {
                            let bound = state.wsl_bound.get(bootstrap_id).ok_or(INVALID)?;
                            if bound.installation.guid != installation.guid {
                                return Err(INVALID);
                            }
                            let linux = wsl::linux_path(&context.path, &installation.distro)
                                .ok_or(INVALID)?;
                            (
                                wsl::wsl_program(),
                                None,
                                context.path,
                                Some((installation, linux)),
                            )
                        }
                        _ => return Err(INVALID),
                    },
                };
                Ok(Target {
                    program,
                    current_dir,
                    bootstrap_id: Some(bootstrap_id.to_string()),
                    git_identity,
                    git_directory: None,
                    wsl,
                })
            }
            Kind::Registered => {
                let found = git(state)?;
                let id = request["repositoryId"].as_str().ok_or(INVALID)?;
                let repository = state.repositories.get(id).ok_or(UNKNOWN)?;
                let (program, git_identity, wsl) = match found {
                    // Contract §11: a WSL repository never runs Git for Windows.
                    Ok(_) if file_facts::is_wsl_path(&repository.worktree_root) => {
                        return Err(INVALID);
                    }
                    Ok((program, identity)) => (program, Some(identity), None),
                    Err(installation) => {
                        let linux =
                            wsl::linux_path(&repository.worktree_root, &installation.distro)
                                .ok_or(INVALID)?;
                        (wsl::wsl_program(), None, Some((installation, linux)))
                    }
                };
                Ok(Target {
                    program,
                    current_dir: repository.worktree_root.clone(),
                    bootstrap_id: None,
                    git_identity,
                    git_directory: Some(repository.git_directory.clone()),
                    wsl,
                })
            }
        }
    }

    /// Reads the selected identities again before execution (contract §6 "Registration bootstrap").
    /// gaps.md W1: a WSL context gets no identity read before a run, because each read starts `wsl.exe`.
    /// `register` reads it again through the §11 identity probe.
    fn revalidate(&self, target: &Target, now: Instant) -> Result<(), Code> {
        if let (Some(bootstrap_id), None) = (&target.bootstrap_id, &target.wsl) {
            self.contexts.revalidate(bootstrap_id, now)?;
        }
        match target.git_identity {
            Some(identity) if read_identity(&target.program) != Ok(identity) => Err("GIT_CHANGED"),
            _ => Ok(()),
        }
    }

    fn write_input(
        self: Arc<Self>,
        call_id: &str,
        generation: u64,
        declared: u64,
        mut stdin: File,
        exited: Arc<Mutex<bool>>,
    ) -> Streamed {
        let (chunks, received) = mpsc::channel::<Vec<u8>>();
        let unacknowledged = Arc::new(AtomicUsize::new(0));
        let pending = Arc::clone(&unacknowledged);
        let call_id = call_id.to_string();
        std::thread::spawn(move || {
            let mut written = 0u64;
            // The channel closes when the call exits, which drops the parent end of stdin.
            for chunk in received {
                if stdin.write_all(&chunk).is_err() {
                    return;
                }
                written += chunk.len() as u64;
                pending.fetch_sub(1, Ordering::SeqCst);
                // `exit` is the last reply of a `run` (contract §6 "Process replies").
                let exited = lock(&exited);
                if !*exited {
                    self.send(
                        generation,
                        json!({ "type": "inputWritten", "callId": call_id }),
                    );
                }
                drop(exited);
                if written == declared {
                    return;
                }
            }
        });
        Streamed {
            chunks,
            declared,
            sent: 0,
            unacknowledged,
        }
    }

    fn input(&self, request: &Fields) -> Result<(), Code> {
        keys(request, &["type", "callId", "data"], &[])?;
        let data = chunk(&request["data"], CHUNK_BYTES)?;
        let call_id = request["callId"].as_str().ok_or(INVALID)?;
        let mut state = self.state();
        // After `exit`, the shell drops each `input` of that call.
        let Some(call) = state.calls.get_mut(call_id) else {
            return Ok(());
        };
        // A call without `inputBytes` refuses the frame, and its Job stays open (contract §6 "Errors").
        let Some(streamed) = call.streamed.as_mut() else {
            return Err(INVALID);
        };
        if streamed.sent + data.len() as u64 <= streamed.declared {
            // Contract §6 "Streamed input": at most 8 chunks wait, and a refused frame keeps the Job open.
            if streamed.unacknowledged.load(Ordering::SeqCst) >= QUEUED_CHUNKS_PER_STREAM {
                return Err(INVALID);
            }
            streamed.sent += data.len() as u64;
            streamed.unacknowledged.fetch_add(1, Ordering::SeqCst);
            let _ = streamed.chunks.send(data);
            return Ok(());
        }
        // A chunk past `inputBytes` closes the operation Job. The `exit` then follows.
        let operation_id = call.operation_id.clone();
        close_job_of(&self.jobs, &mut state, &operation_id);
        Ok(())
    }

    fn cancel(&self, request: &Fields) -> Result<(), Code> {
        keys(request, &["type", "callId"], &[])?;
        let call_id = request["callId"].as_str().ok_or(INVALID)?;
        let mut state = self.state();
        // A cancel for an ended call is dropped.
        if let Some(operation_id) = state.calls.get(call_id).map(|c| c.operation_id.clone()) {
            close_job_of(&self.jobs, &mut state, &operation_id);
        } else if let Some(walk) = state.walks.get(call_id) {
            let _ = walk.events.send(WalkEvent::Stop);
        }
        Ok(())
    }

    fn identity(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        let read_at = Instant::now();
        keys(
            request,
            &["type", "callId", "operationId", "contextKind", "paths"],
            &["bootstrapId", "gitInstallationId", "repositoryId"],
        )?;
        let operation_id = identifier(&request["operationId"])?;
        let kind = context_kind(request)?;
        let paths: Vec<PathBuf> = request["paths"]
            .as_array()
            .filter(|paths| (1..=IDENTITY_PATHS).contains(&paths.len()))
            .ok_or(INVALID)?
            .iter()
            .map(path)
            .collect::<Result<_, _>>()?;
        let mut state = self.state();
        check_active(&state, operation_id)?;
        let target = self.target(&mut state, request, kind, operation_id)?;
        if let Some((installation, _)) = target.wsl {
            let n = Self::next_unit(&mut state, operation_id);
            return self.wsl_identity(
                state,
                &installation,
                operation_id,
                n,
                &paths,
                call_id,
                read_at,
            );
        }
        let call = call_id.to_string();
        self.spawn_walk(
            state,
            "identity",
            call_id,
            operation_id,
            read_at,
            move |stop| {
                let stop = &stop.flag;
                let identities: Vec<Value> = paths
                    .iter()
                    .take_while(|_| !stop.load(Ordering::SeqCst))
                    .map_while(|path| identity_reply(path, stop))
                    .collect();
                json!({ "type": "identity", "callId": call, "identities": identities })
            },
        )
    }

    /// gaps.md W4 and W9: one identity probe for the request, as a walk. A path outside the distro gets the refusal alone.
    #[allow(clippy::too_many_arguments)]
    fn wsl_identity(
        &self,
        state: MutexGuard<'_, State>,
        installation: &wsl::Installation,
        operation_id: &str,
        n: u32,
        paths: &[PathBuf],
        call_id: &str,
        read_at: Instant,
    ) -> Result<(), Code> {
        self.jobs.open(operation_id).map_err(|_| OWNERSHIP)?;
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        let linux: Vec<String> = paths
            .iter()
            .map(|path| wsl::linux_path(path, &installation.distro).unwrap_or_default())
            .collect();
        let (installation, operation, call) = (
            installation.clone(),
            operation_id.to_string(),
            call_id.to_string(),
        );
        let deadline = self.walk_bound();
        self.spawn_walk(
            state,
            "identity",
            call_id,
            operation_id,
            read_at,
            move |stop| {
                let host = me.wsl_host(&operation);
                let identities: Vec<Value> = wsl::identities(
                    &*host,
                    &installation,
                    &operation,
                    n,
                    &linux,
                    &me.config.base_environment,
                    Some((stop.event.0, deadline)),
                )
                .into_iter()
                .map(|found| match found {
                    Ok(identity) => identity.reply(),
                    Err(wsl::Refusal::Invalid) => wsl::Refusal::Failed.reply(),
                    Err(refusal) => refusal.reply(),
                })
                .collect();
                json!({ "type": "identity", "callId": call, "identities": identities })
            },
        )
    }

    fn file_facts(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        let read_at = Instant::now();
        let parsed = file_facts::parse(request)?;
        let mut state = self.state();
        check_active(&state, parsed.operation_id)?;
        let target = self.target(&mut state, request, Kind::Registered, parsed.operation_id)?;
        let id = request["repositoryId"].as_str().ok_or(INVALID)?;
        let repository = state.repositories.get(id).ok_or(UNKNOWN)?;
        let roots = [
            repository.worktree_root.clone(),
            repository.git_directory.clone(),
            repository.common_directory.clone(),
        ];
        if let Some((installation, _)) = target.wsl {
            let n = Self::next_unit(&mut state, parsed.operation_id);
            return self.wsl_file_facts(state, &parsed, &installation, &roots, n, call_id, read_at);
        }
        // A Windows Git never reads a WSL repository (contract §11 "Route").
        if roots.iter().any(|root| file_facts::is_wsl_path(root)) {
            return Err(INVALID);
        }
        let (digest, files, call) = (parsed.digest, parsed.files, call_id.to_string());
        self.spawn_walk(
            state,
            "fileFacts",
            call_id,
            parsed.operation_id,
            read_at,
            move |stop| {
                let facts = file_facts::walk(
                    [&roots[0], &roots[1], &roots[2]],
                    digest,
                    &files,
                    &stop.flag,
                );
                json!({ "type": "fileFacts", "callId": call, "facts": facts })
            },
        )
    }

    /// The bound of the host wait of a WSL walk. The watchdog sets the stop Event at the walk deadline, and this bound lies one probe deadline later.
    /// So only a lost stop reaches it.
    fn walk_bound(&self) -> Duration {
        self.config.walk_deadline + Duration::from_millis(BOOTSTRAP_DEADLINE_MS)
    }

    /// Runs `work` on its own thread with a watchdog thread (contract §6 "Walks").
    /// Only the watchdog sends a reply, so a walk gets one reply or none.
    fn spawn_walk(
        &self,
        mut state: MutexGuard<'_, State>,
        kind: &'static str,
        call_id: &str,
        operation_id: &str,
        read_at: Instant,
        work: impl FnOnce(&WalkStop) -> Value + Send + 'static,
    ) -> Result<(), Code> {
        if state.calls.contains_key(call_id) || state.walks.contains_key(call_id) {
            return Err(INVALID);
        }
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        let stop = Arc::new(WalkStop::new().ok_or(OWNERSHIP)?);
        let (events, received) = mpsc::channel();
        state.walks.insert(
            call_id.to_string(),
            Walk {
                operation_id: operation_id.to_string(),
                events: events.clone(),
            },
        );
        let generation = self.current();
        drop(state);

        self.walk_threads.fetch_add(1, Ordering::SeqCst);
        let worker = {
            let (me, stop) = (Arc::clone(&me), Arc::clone(&stop));
            std::thread::Builder::new().spawn(move || {
                let mut end = WalkEnd {
                    me,
                    events,
                    reply: None,
                };
                end.reply = Some(work(&stop));
            })
        };
        let worker = match worker {
            Ok(worker) => Arc::new(worker),
            Err(_) => {
                self.walk_threads.fetch_sub(1, Ordering::SeqCst);
                self.state().walks.remove(call_id);
                return Err(OWNERSHIP);
            }
        };
        let (deadline, call) = (read_at + self.config.walk_deadline, call_id.to_string());
        let watchdog = {
            let (worker, stop) = (Arc::clone(&worker), Arc::clone(&stop));
            std::thread::Builder::new().spawn(move || {
                let event =
                    received.recv_timeout(deadline.saturating_duration_since(Instant::now()));
                // `cancel` and `closeJob` send `Stop` under the state lock while `walks` holds the walk.
                // So after the removal, the queue holds each such `Stop`.
                let stopped = {
                    let mut state = me.state();
                    state.walks.remove(&call);
                    received
                        .try_iter()
                        .any(|event| matches!(event, WalkEvent::Stop))
                };
                let reply = match event {
                    _ if stopped => None,
                    Ok(WalkEvent::Done(reply)) => return me.send(generation, reply),
                    Err(RecvTimeoutError::Timeout) => {
                        Some(json!({ "type": kind, "callId": call, "deadline": "deadline" }))
                    }
                    Ok(WalkEvent::Stop) | Err(RecvTimeoutError::Disconnected) => None,
                };
                stop_walk(&stop, &worker);
                if let Some(reply) = reply {
                    me.send(generation, reply);
                }
            })
        };
        if watchdog.is_err() {
            self.state().walks.remove(call_id);
            stop_walk(&stop, &worker);
            return Err(OWNERSHIP);
        }
        Ok(())
    }

    fn lingering_count(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        keys(
            request,
            &["type", "callId", "operationId", "commonDirectory"],
            &[],
        )?;
        let operation_id = identifier(&request["operationId"])?;
        let common = path(&request["commonDirectory"])?;
        check_active(&self.state(), operation_id)?;
        // An unreadable identity gives 0.
        let count = self
            .read_physical_identity(&common)
            .map_or(0, |tag| self.jobs.lingering_count(&tag));
        self.send(
            self.current(),
            json!({ "type": "lingeringCount", "callId": call_id, "count": count }),
        );
        Ok(())
    }

    fn register(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        const GIT: [&str; 3] = ["version", "digest", "confirm"];
        const REPOSITORY: [&str; 4] = [
            "repositoryId",
            "worktreeRoot",
            "gitDirectory",
            "commonDirectory",
        ];
        keys(
            request,
            &[
                "type",
                "callId",
                "operationId",
                "bootstrapId",
                "gitInstallationId",
            ],
            &[GIT.as_slice(), REPOSITORY.as_slice()].concat(),
        )?;
        let operation_id = identifier(&request["operationId"])?;
        let bootstrap_id = identifier(&request["bootstrapId"])?;
        let git_id = identifier(&request["gitInstallationId"])?;
        let has = |names: &[&str]| names.iter().filter(|&&n| request.contains_key(n)).count();
        let git_form = match (has(&GIT), has(&REPOSITORY)) {
            (3, 0) => true,
            (0, 4) => false,
            // The WSL form holds only `confirm` (contract §6 "Channel frames", §11).
            (1, 0) if request.contains_key("confirm") => {
                return self.register_wsl(request, call_id);
            }
            _ => return Err(INVALID),
        };
        let now = Instant::now();
        let mut state = self.state();
        let result = if git_form {
            let version = request["version"].as_str().ok_or(INVALID)?;
            if version.len() > VERSION_BYTES || !version.bytes().all(|b| (0x20..0x7f).contains(&b))
            {
                return Err(INVALID);
            }
            let digest = request["digest"]
                .as_str()
                .filter(|digest| is_hex(digest, 64))
                .ok_or(INVALID)?;
            let confirm = request["confirm"].as_bool().ok_or(INVALID)?;
            if state.issued.contains(git_id) {
                return Err(INVALID);
            }
            check_active(&state, operation_id)?;
            let context = self.contexts.get(bootstrap_id, now)?;
            if context.kind != ContextKind::GitProbe {
                return Err(UNKNOWN);
            }
            // Only a startup context skips Use this Git (contract §6 "Startup contexts", FR-003).
            if !confirm && !context.startup {
                return Err(INVALID);
            }
            own(&mut state, &self.contexts, bootstrap_id, operation_id, now)?;
            let ContextIdentity::Windows(identity) = context.identity else {
                return Err(INVALID);
            };
            self.contexts.revalidate(bootstrap_id, now)?;
            self.contexts.destroy(bootstrap_id);
            if confirm {
                drop(state);
                self.confirm_git(
                    ConfirmedGit {
                        selected_path: context.selected,
                        executable_path: context.path,
                        version: version.to_string(),
                        digest: digest.to_string(),
                    },
                    identity,
                    git_id,
                    call_id,
                );
                return Ok(());
            }
            state.issued.insert(git_id.to_string());
            state.gits.insert(
                git_id.to_string(),
                Git::Windows {
                    program: context.path.clone(),
                    identity,
                },
            );
            drop(state);
            if let Some(save) = self.startup_git.get() {
                save(ConfirmedGit {
                    selected_path: context.selected,
                    executable_path: context.path,
                    version: version.to_string(),
                    digest: digest.to_string(),
                });
            }
            self.send(
                self.current(),
                json!({ "type": "register", "callId": call_id, "result": "approved" }),
            );
            return Ok(());
        } else {
            let repository_id = identifier(&request["repositoryId"])?;
            let worktree_root = path(&request["worktreeRoot"])?;
            let git_directory = path(&request["gitDirectory"])?;
            let common_directory = path(&request["commonDirectory"])?;
            if state.issued.contains(repository_id) {
                return Err(INVALID);
            }
            check_active(&state, operation_id)?;
            let context = self.contexts.get(bootstrap_id, now)?;
            if context.kind != ContextKind::RepositoryDiscovery {
                return Err(UNKNOWN);
            }
            own(&mut state, &self.contexts, bootstrap_id, operation_id, now)?;
            let repository = Repository {
                worktree_root,
                git_directory,
                common_directory,
                git_installation_id: git_id.to_string(),
            };
            match (state.gits.get(git_id).ok_or(UNKNOWN)?, context.identity) {
                (Git::Windows { .. }, ContextIdentity::Windows(_)) => {}
                (Git::Wsl(installation), ContextIdentity::Wsl) => {
                    let installation = installation.clone();
                    drop(state);
                    return self.register_wsl_repository(
                        operation_id,
                        bootstrap_id,
                        repository_id,
                        &context.path,
                        &installation,
                        repository,
                        call_id,
                    );
                }
                _ => return Err(INVALID),
            }
            self.contexts.revalidate(bootstrap_id, now)?;
            self.contexts.destroy(bootstrap_id);
            state.issued.insert(repository_id.to_string());
            state
                .repositories
                .insert(repository_id.to_string(), repository);
            "approved"
        };
        drop(state);
        self.send(
            self.current(),
            json!({ "type": "register", "callId": call_id, "result": result }),
        );
        Ok(())
    }

    /// Contract §6 `wslDistros` and §11 "Route": the context path, and for a WSL prefix the distro facts.
    /// The list calls run on their own thread in the operation Job, so the frame reader keeps running.
    fn wsl_distros(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        let schema::wsl_request::WslRequest::WslDistros {
            operation_id,
            bootstrap_id,
            ..
        } = schema::wsl_request(&Value::Object(request.clone()))?
        else {
            return Err(INVALID);
        };
        let (operation_id, bootstrap_id): (&str, &str) = (&operation_id, &bootstrap_id);
        let now = Instant::now();
        let path = {
            let mut state = self.state();
            check_active(&state, operation_id)?;
            let context = self.contexts.get(bootstrap_id, now)?;
            if context.kind != ContextKind::RepositoryDiscovery {
                return Err(UNKNOWN);
            }
            own(&mut state, &self.contexts, bootstrap_id, operation_id, now)?;
            context.path
        };
        let generation = self.current();
        let mut reply = json!({ "type": "wslDistros", "callId": call_id, "path": path.to_str().ok_or(INVALID)? });
        if !file_facts::is_wsl_path(&path) {
            self.send(generation, reply);
            return Ok(());
        }
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        self.jobs.open(operation_id).map_err(|_| OWNERSHIP)?;
        let operation_id = operation_id.to_string();
        std::thread::spawn(move || {
            let host = me.wsl_host(&operation_id);
            let facts = wsl::distros(&*host, &me.config.base_environment);
            let saved = me.wsl_saved.get().map(|saved| saved()).unwrap_or_default();
            wsl::distros_reply(&mut reply, facts, &saved);
            me.send(generation, reply);
        });
        Ok(())
    }

    /// Contract §11 "Process launch": the wrapper command of one Git process of a WSL Git.
    /// Only a mutation passes the candidate index, as the Linux path of the checked file below the Git directory.
    #[allow(clippy::too_many_arguments)]
    fn wsl_run_command(
        &self,
        state: &mut State,
        operation_id: &str,
        installation: &wsl::Installation,
        directory: &str,
        policy: &str,
        index_file: Option<&Path>,
        arguments: &[String],
        input: &RunInput,
    ) -> Result<wsl::Command, Code> {
        let mode = match policy {
            "probe" => wsl::Mode::Probe,
            "read" => wsl::Mode::Read,
            "mutation" => wsl::Mode::Mutation,
            _ => return Err(INVALID),
        };
        let index = index_file
            .map(|file| wsl::linux_path(file, &installation.distro).ok_or(INVALID))
            .transpose()?;
        let unit = wsl::unit_name(operation_id, Self::next_unit(state, operation_id))?;
        let stdin = match input {
            RunInput::Closed => wsl::Stdin::Closed,
            RunInput::Bytes(bytes) => wsl::Stdin::Bytes(bytes.clone()),
            RunInput::Streamed(_) => wsl::Stdin::Open,
        };
        wsl::git_command(
            installation,
            mode,
            &unit,
            index.as_deref(),
            directory,
            arguments,
            &self.config.base_environment,
            stdin,
        )
    }

    /// Contract §6 `wslProbe` (§11 "Git per distro", gaps.md W1): the bootstrap probe of a WSL context, with its Linux path.
    /// It answers as `run`: `output` frames, then `exit`. At exit status 0, the shell binds the facts that pass every §11 rule, once.
    fn wsl_probe(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        let schema::wsl_request::WslRequest::WslProbe {
            operation_id,
            bootstrap_id,
            distro,
            limits,
            ..
        } = schema::wsl_request(&Value::Object(request.clone()))?
        else {
            return Err(INVALID);
        };
        let (operation_id, bootstrap_id, distro): (&str, &str, &str) =
            (&operation_id, &bootstrap_id, &distro);
        let deadline = Duration::from_millis(limits.deadline_ms.get());
        let now = Instant::now();
        let mut state = self.state();
        if state.calls.contains_key(call_id) {
            return Err(INVALID);
        }
        check_active(&state, operation_id)?;
        let context = self.contexts.get(bootstrap_id, now)?;
        if context.kind != ContextKind::RepositoryDiscovery {
            return Err(UNKNOWN);
        }
        own(&mut state, &self.contexts, bootstrap_id, operation_id, now)?;
        // gaps.md W1: a context binds once, because a rebind would defeat the revalidation at `register`.
        if context.identity != ContextIdentity::Wsl
            || state.wsl_bound.contains_key(bootstrap_id)
            || state.wsl_probing.contains(bootstrap_id)
        {
            return Err(INVALID);
        }
        let linux = wsl::linux_path(&context.path, distro).ok_or(INVALID)?;
        let host = self.wsl_host(operation_id);
        let guid = wsl::lookup(&host.keys(), distro)
            .map_err(|_| INVALID)?
            .guid
            .clone();
        let command = wsl::probe_command(distro, &linux, &self.config.base_environment);
        command_line(&command.program, &command.arguments).map_err(|_| INVALID)?;
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        self.jobs.open(operation_id).map_err(|_| OWNERSHIP)?;
        state.calls.insert(
            call_id.to_string(),
            Call {
                operation_id: operation_id.to_string(),
                streamed: None,
                closed: false,
            },
        );
        state.wsl_probing.insert(bootstrap_id.to_string());
        drop(state);
        let generation = self.current();
        let (call_id, bootstrap_id, distro, operation_id) = (
            call_id.to_string(),
            bootstrap_id.to_string(),
            distro.to_string(),
            operation_id.to_string(),
        );
        std::thread::spawn(move || {
            let ended = host.run_until(&command, wsl::RETAINED_BYTES, deadline);
            let mut state = me.state();
            // A Job close after the start ended the probe, so its exit carries `exitCode` null and binds nothing.
            let closed = state.calls.remove(&call_id).is_some_and(|call| call.closed);
            let output = ended.output.filter(|_| !closed);
            let exit_code = output.as_ref().and_then(|out| out.exit_code);
            state.wsl_probing.remove(&bootstrap_id);
            if let (Some(0), Some(out)) = (exit_code, &output)
                && let Some(bound) = wsl::bind_probe(&distro, &guid, &out.stdout)
            {
                state.wsl_bound.entry(bootstrap_id).or_insert(bound);
            }
            drop(state);
            for chunk in output.iter().flat_map(|out| out.stdout.chunks(CHUNK_BYTES)) {
                me.send(
                    generation,
                    json!({ "type": "output", "callId": call_id, "stream": "stdout", "data": encode_base64(chunk) }),
                );
            }
            let active = me.jobs.active_processes(&operation_id).unwrap_or(0);
            let mut exit = json!({ "type": "exit", "callId": call_id, "exitCode": exit_code, "activeDescendants": active });
            if ended.deadline {
                exit["deadline"] = json!("deadline");
            }
            me.send(generation, exit);
        });
        Ok(())
    }

    /// Contract §6 `register` WSL form: the shell issues the ID only from the facts that `wslProbe` bound, after Use this Git.
    /// It then saves those facts for the distro GUID. The service never sends a Linux program path.
    fn register_wsl(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        let schema::wsl_request::WslRequest::Register {
            operation_id,
            bootstrap_id,
            git_installation_id,
            ..
        } = schema::wsl_request(&Value::Object(request.clone()))?
        else {
            return Err(INVALID);
        };
        let (operation_id, bootstrap_id, git_id): (&str, &str, &str) =
            (&operation_id, &bootstrap_id, &git_installation_id);
        let now = Instant::now();
        let mut state = self.state();
        if state.issued.contains(git_id) {
            return Err(INVALID);
        }
        check_active(&state, operation_id)?;
        let context = self.contexts.get(bootstrap_id, now)?;
        if context.kind != ContextKind::RepositoryDiscovery {
            return Err(UNKNOWN);
        }
        own(&mut state, &self.contexts, bootstrap_id, operation_id, now)?;
        let bound = state.wsl_bound.get(bootstrap_id).cloned().ok_or(INVALID)?;
        drop(state);
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        let generation = self.current();
        let (git_id, call_id) = (git_id.to_string(), call_id.to_string());
        // The confirmation runs on its own thread, so the frame reader keeps running.
        std::thread::spawn(move || {
            let installation = &bound.installation;
            let approved = me.wsl_confirmation.get().is_some_and(|confirm| {
                confirm(&installation.distro, &installation.git, &bound.version)
            });
            let mut result = "declined";
            if approved {
                let mut state = me.state();
                if generation == me.current() && !state.issued.contains(&git_id) {
                    state.issued.insert(git_id.clone());
                    state.gits.insert(git_id, Git::Wsl(installation.clone()));
                    result = "approved";
                }
            }
            if let (Some(store), "approved") = (me.wsl_store.get(), result) {
                let file = &bound.git_identity;
                store(SavedWslGit {
                    guid: installation.guid.clone(),
                    distro: installation.distro.clone(),
                    git: installation.git.clone(),
                    version: bound.version.clone(),
                    identity: format!(
                        "{}:{}:{}:{}",
                        file.file_system_id, file.inode, file.size, file.modified
                    ),
                });
            }
            me.send(
                generation,
                json!({ "type": "register", "callId": call_id, "result": result }),
            );
        });
        Ok(())
    }

    /// gaps.md W1: before the repository ID binds, the shell reads the context identity again with the §11 identity probe.
    /// A changed or failed read destroys the context. The three paths lie in the bound distro, and the Git has the bound GUID.
    #[allow(clippy::too_many_arguments)]
    fn register_wsl_repository(
        &self,
        operation_id: &str,
        bootstrap_id: &str,
        repository_id: &str,
        context_path: &Path,
        installation: &wsl::Installation,
        repository: Repository,
        call_id: &str,
    ) -> Result<(), Code> {
        let (bound, n) = {
            let mut state = self.state();
            let bound = state.wsl_bound.get(bootstrap_id).cloned().ok_or(INVALID)?;
            let distro = &bound.installation.distro;
            let inside = [
                &repository.worktree_root,
                &repository.git_directory,
                &repository.common_directory,
            ]
            .iter()
            .all(|path| wsl::linux_path(path, distro).is_some());
            if bound.installation.guid != installation.guid || !inside {
                return Err(INVALID);
            }
            (bound, Self::next_unit(&mut state, operation_id))
        };
        let linux = wsl::linux_path(context_path, &bound.installation.distro).ok_or(INVALID)?;
        self.jobs.open(operation_id).map_err(|_| OWNERSHIP)?;
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        let generation = self.current();
        let installation = installation.clone();
        let (operation_id, bootstrap_id, repository_id, call_id) = (
            operation_id.to_string(),
            bootstrap_id.to_string(),
            repository_id.to_string(),
            call_id.to_string(),
        );
        std::thread::spawn(move || {
            let host = me.wsl_host(&operation_id);
            let found = wsl::identities(
                &*host,
                &installation,
                &operation_id,
                n,
                &[linux],
                &me.config.base_environment,
                None,
            );
            let same = found
                .first()
                .is_some_and(|found| found.as_ref() == Ok(&bound.identity));
            let mut state = me.state();
            let live = me.contexts.get(&bootstrap_id, Instant::now()).is_ok();
            me.contexts.destroy(&bootstrap_id);
            state.wsl_bound.remove(&bootstrap_id);
            let reply = if !same || !live || state.issued.contains(&repository_id) {
                json!({ "type": "refused", "callId": call_id, "code": UNKNOWN })
            } else {
                state.issued.insert(repository_id.clone());
                state.repositories.insert(repository_id, repository);
                json!({ "type": "register", "callId": call_id, "result": "approved" })
            };
            drop(state);
            me.send(generation, reply);
        });
        Ok(())
    }

    /// gaps.md W3: the Perl probe of a WSL repository, on its own thread, in the Job of the request operation.
    #[allow(clippy::too_many_arguments)]
    fn wsl_file_facts(
        &self,
        state: MutexGuard<'_, State>,
        parsed: &file_facts::Request,
        installation: &wsl::Installation,
        roots: &[PathBuf; 3],
        n: u32,
        call_id: &str,
        read_at: Instant,
    ) -> Result<(), Code> {
        let linux: Vec<String> = roots
            .iter()
            .map(|root| wsl::linux_path(root, &installation.distro))
            .collect::<Option<_>>()
            .ok_or(INVALID)?;
        let roots: [String; 3] = linux.try_into().map_err(|_| INVALID)?;
        let unit = wsl::unit_name(parsed.operation_id, n)?;
        let entries: Vec<wsl::FactEntry> = parsed
            .files
            .iter()
            .map(|(root, path)| wsl::FactEntry {
                root: *root,
                path: path.iter().map(|component| component.to_string()).collect(),
            })
            .collect();
        let command = wsl::file_facts_command(
            installation,
            &unit,
            parsed.digest,
            &roots,
            &entries,
            &self.config.base_environment,
        );
        command_line(&command.program, &command.arguments).map_err(|_| INVALID)?;
        self.jobs.open(parsed.operation_id).map_err(|_| OWNERSHIP)?;
        let me = self.me.upgrade().ok_or(OWNERSHIP)?;
        let (operation, call, digest) = (
            parsed.operation_id.to_string(),
            call_id.to_string(),
            parsed.digest,
        );
        let deadline = self.walk_bound();
        self.spawn_walk(
            state,
            "fileFacts",
            call_id,
            parsed.operation_id,
            read_at,
            move |stop| {
                let host = me.wsl_host(&operation);
                // One byte above the cap shows output past it.
                let ended = host.run_walk(
                    &command,
                    wsl::FACTS_OUTPUT_BYTES + 1,
                    deadline,
                    stop.event.0,
                );
                let facts = wsl::file_facts_reply(ended.output, &entries, digest);
                json!({ "type": "fileFacts", "callId": call, "facts": facts })
            },
        )
    }

    /// Replaces a `gitProbe` context with one for `<exec-path>\git.exe` (contract §6 "Channel frames" `resolveGit`).
    fn resolve_git(&self, request: &Fields, call_id: &str) -> Result<(), Code> {
        keys(
            request,
            &[
                "type",
                "callId",
                "operationId",
                "bootstrapId",
                "executablePath",
            ],
            &[],
        )?;
        let operation_id = identifier(&request["operationId"])?;
        let bootstrap_id = identifier(&request["bootstrapId"])?;
        let resolved = path(&request["executablePath"])?;
        let named = resolved
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("git.exe"));
        if !named || !std::fs::metadata(&resolved).is_ok_and(|file| file.is_file()) {
            return Err(INVALID);
        }
        let now = Instant::now();
        let mut state = self.state();
        check_active(&state, operation_id)?;
        let context = self.contexts.get(bootstrap_id, now)?;
        if context.kind != ContextKind::GitProbe {
            return Err(UNKNOWN);
        }
        own(&mut state, &self.contexts, bootstrap_id, operation_id, now)?;
        let moved = self
            .contexts
            .create_moved(&context, &resolved, now)
            .map_err(|_| INVALID)?;
        self.contexts.destroy(bootstrap_id);
        own(&mut state, &self.contexts, &moved, operation_id, now)?;
        drop(state);
        self.send(
            self.current(),
            json!({ "type": "resolveGit", "callId": call_id, "bootstrapId": moved }),
        );
        Ok(())
    }

    /// Shows the Git selection confirmation on its own thread, so the frame reader keeps running.
    /// Only Use this Git binds the ID. A reply after a service exit is dropped and binds nothing.
    fn confirm_git(&self, proposal: ConfirmedGit, identity: Identity, git_id: &str, call_id: &str) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        let generation = self.current();
        let (git_id, call_id) = (git_id.to_string(), call_id.to_string());
        std::thread::spawn(move || {
            let mut registered =
                me.git_confirmation
                    .get()
                    .map_or(Registered::Declined, |confirm| {
                        confirm(
                            &proposal.selected_path,
                            &proposal.executable_path,
                            &proposal.version,
                        )
                    });
            if registered == Registered::Approved {
                let mut state = me.state();
                if generation != me.current() || state.issued.contains(&git_id) {
                    registered = Registered::Declined;
                } else {
                    state.issued.insert(git_id.clone());
                    let program = proposal.executable_path.clone();
                    state.confirmed.insert(git_id.clone(), proposal);
                    state
                        .gits
                        .insert(git_id, Git::Windows { program, identity });
                }
            }
            me.send(generation, registered.reply(&call_id));
        });
    }

    fn release(&self, request: &Fields) -> Result<(), Code> {
        let mut state = self.state();
        match (
            request.get("repositoryId"),
            request.get("gitInstallationId"),
        ) {
            (Some(id), None) => {
                keys(request, &["type", "repositoryId"], &[])?;
                state.repositories.remove(identifier(id)?);
            }
            (None, Some(id)) => {
                keys(request, &["type", "gitInstallationId"], &[])?;
                state.gits.remove(identifier(id)?);
            }
            _ => return Err(INVALID),
        }
        Ok(())
    }

    fn close_job(&self, request: &Fields) -> Result<(), Code> {
        keys(request, &["type", "operationId"], &[])?;
        let operation_id = identifier(&request["operationId"])?;
        let mut state = self.state();
        close_job_of(&self.jobs, &mut state, operation_id);
        for walk in state.walks.values() {
            if walk.operation_id == operation_id {
                let _ = walk.events.send(WalkEvent::Stop);
            }
        }
        deactivate(&mut state, operation_id);
        Ok(())
    }

    /// Reads one pipe. Every read runs under the drain lock, so the completion signal sees an exact pipe count.
    fn read_stream(&self, run: &Run, stream: usize) {
        let pipe = &run.pipes[stream];
        let mut buffer = vec![0u8; CHUNK_BYTES];
        // The chunks that this stream read and did not yet write to the service.
        let mut queued = 0;
        let mut drain = lock(&run.state);
        while let Some(available) = peek(pipe) {
            let limit = match drain.budget[stream] {
                Some(0) => break,
                Some(budget) => budget.min(CHUNK_BYTES as u64) as usize,
                None => CHUNK_BYTES,
            };
            if available == 0 {
                drain = run
                    .changed
                    .wait_timeout(drain, POLL)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
                continue;
            }
            // The pipe holds `available` bytes, so this read does not block.
            let Ok(read) = (&*pipe).read(&mut buffer[..available.min(limit)]) else {
                break;
            };
            if read == 0 {
                break;
            }
            if let Some(budget) = &mut drain.budget[stream] {
                *budget -= read as u64;
            }
            drop(drain);
            // A stream holds one chunk at a time, and its pipe waits while the frame write runs.
            queued += 1;
            self.peak.fetch_max(queued, Ordering::SeqCst);
            self.send(
                run.generation,
                json!({
                    "type": "output", "callId": run.call_id, "stream": STREAMS[stream],
                    "data": encode_base64(&buffer[..read]),
                }),
            );
            queued -= 1;
            drain = lock(&run.state);
        }
        drain.done[stream] = true;
        run.changed.notify_all();
        drop(drain);
        // The discard sink: later bytes count toward no cap, and the shell never forwards them.
        while matches!((&*pipe).read(&mut buffer), Ok(read) if read > 0) {}
    }

    /// Ends the run at its process handle signal, never at pipe end-of-file (contract §6 "Completion signal").
    fn watch(&self, run: &Run, process: Owned, deadline: Duration) {
        let mut expired = false;
        if !wait(process.0, deadline) {
            expired = true;
            close_job_of(&self.jobs, &mut self.state(), &run.operation_id);
            wait(process.0, CLOSE_WAIT);
        }
        let closed = self
            .state()
            .calls
            .get(&run.call_id)
            .is_some_and(|call| call.closed);
        let active = self.jobs.active_processes(&run.operation_id).unwrap_or(0);
        let mut code = 0u32;
        // SAFETY: `process` owns the open process handle, and `code` is a live local.
        let read = unsafe { GetExitCodeProcess(process.0, &mut code) }.is_ok();
        let exit_code = if closed || !read {
            Value::Null
        } else {
            json!(code)
        };
        drop(process);

        let mut drain = lock(&run.state);
        for stream in 0..2 {
            if !drain.done[stream] {
                drain.budget[stream] = Some(peek(&run.pipes[stream]).unwrap_or(0) as u64);
            }
        }
        run.changed.notify_all();
        while !drain.done.iter().all(|&done| done) {
            drain = run
                .changed
                .wait_timeout(drain, Duration::from_secs(1))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        drop(drain);

        // Removing the call drops its input channel, so later `input` and `cancel` frames are dropped.
        self.state().calls.remove(&run.call_id);
        *lock(&run.exited) = true;
        let mut exit = json!({
            "type": "exit", "callId": run.call_id, "exitCode": exit_code, "activeDescendants": active,
        });
        if expired {
            exit["deadline"] = json!("deadline");
        }
        self.send(run.generation, exit);
    }
}

/// An owned process handle. Drop closes it.
pub(crate) struct Owned(pub(crate) HANDLE);

// SAFETY: a process handle is a kernel handle that any thread can use. `Owned` is its only owner.
unsafe impl Send for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: `Owned` owns the handle and closes it once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Sets the stop flag and the stop Event of a walk, then cancels the synchronous I/O of its thread (contract §6 "Walks").
/// The Event ends the `wsl.exe` of a WSL walk, so the stop never closes the operation Job.
fn stop_walk(stop: &WalkStop, worker: &JoinHandle<()>) {
    stop.flag.store(true, Ordering::SeqCst);
    // SAFETY: `stop` keeps the Event open for the call.
    let _ = unsafe { SetEvent(stop.event.0) };
    // SAFETY: `worker` keeps the thread handle open for the call. A thread outside I/O gives `ERROR_NOT_FOUND`.
    let _ = unsafe { CancelSynchronousIo(HANDLE(worker.as_raw_handle())) };
}

/// True when the handle signals within `timeout`.
pub(crate) fn wait(process: HANDLE, timeout: Duration) -> bool {
    let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
    // SAFETY: the caller keeps the process handle open for the call.
    unsafe { WaitForSingleObject(process, ms) == WAIT_OBJECT_0 }
}

/// The bytes that the pipe holds. `None` at end-of-file or on a failed call.
fn peek(pipe: &File) -> Option<usize> {
    let mut available = 0u32;
    // SAFETY: `pipe` keeps the handle open, and `available` is a live local.
    unsafe {
        PeekNamedPipe(
            HANDLE(pipe.as_raw_handle()),
            None,
            0,
            None,
            Some(&raw mut available),
            None,
        )
    }
    .ok()?;
    Some(available as usize)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn close_job_of(jobs: &Supervisor, state: &mut State, operation_id: &str) {
    mark_closed(state, operation_id);
    jobs.close(operation_id);
}

fn mark_closed(state: &mut State, operation_id: &str) {
    for call in state.calls.values_mut() {
        if call.operation_id == operation_id {
            call.closed = true;
        }
    }
}

fn deactivate(state: &mut State, operation_id: &str) {
    state.wsl_units.remove(operation_id);
    if !state.inactive.iter().any(|id| id == operation_id) {
        state.inactive.push_back(operation_id.to_string());
    }
    if state.inactive.len() > INACTIVE_OPERATIONS {
        state.inactive.pop_front();
    }
}

/// An operation is active from its first request until `ended` or `closeJob` (contract §6 "Channel frames").
fn check_active(state: &State, operation_id: &str) -> Result<(), Code> {
    if state.inactive.iter().any(|id| id == operation_id) {
        return Err(UNKNOWN);
    }
    Ok(())
}

/// An owner leaves with its context, because a destroyed or expired context refuses each request.
fn own(
    state: &mut State,
    contexts: &Contexts,
    bootstrap_id: &str,
    operation_id: &str,
    now: Instant,
) -> Result<(), Code> {
    state.owners.retain(|id, _| contexts.get(id, now).is_ok());
    state
        .wsl_bound
        .retain(|id, _| contexts.get(id, now).is_ok());
    match state.owners.entry(bootstrap_id.to_string()) {
        Entry::Occupied(owner) if owner.get() != operation_id => Err(UNKNOWN),
        Entry::Occupied(_) => Ok(()),
        Entry::Vacant(owner) => {
            owner.insert(operation_id.to_string());
            Ok(())
        }
    }
}

/// Each key is required or optional, and no other key exists.
pub(crate) fn keys(request: &Fields, required: &[&str], optional: &[&str]) -> Result<(), Code> {
    let known = request
        .keys()
        .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()));
    if known && required.iter().all(|k| request.contains_key(*k)) {
        Ok(())
    } else {
        Err(INVALID)
    }
}

/// The context IDs that each `contextKind` carries (contract §6 "Channel frames" `run` fields).
fn context_kind(request: &Fields) -> Result<Kind, Code> {
    let (kind, present) = match request["contextKind"].as_str() {
        Some("gitProbe") => (Kind::Bootstrap(ContextKind::GitProbe), [true, false, false]),
        Some("repositoryDiscovery") => (
            Kind::Bootstrap(ContextKind::RepositoryDiscovery),
            [true, true, false],
        ),
        Some("registeredOperation") => (Kind::Registered, [false, true, true]),
        _ => return Err(INVALID),
    };
    for (name, present) in ["bootstrapId", "gitInstallationId", "repositoryId"]
        .into_iter()
        .zip(present)
    {
        match request.get(name) {
            Some(id) if present => {
                identifier(id)?;
            }
            None if !present => {}
            _ => return Err(INVALID),
        }
    }
    Ok(kind)
}

/// `{deadlineMs, stallMs?}` within the contract caps. `stallMs` exists only in `registeredOperation`.
fn deadline(limits: &Value, kind: Kind) -> Result<Duration, Code> {
    let limits = limits.as_object().ok_or(INVALID)?;
    keys(limits, &["deadlineMs"], &["stallMs"])?;
    let cap = match kind {
        Kind::Registered => REGISTERED_DEADLINE_MS,
        Kind::Bootstrap(_) => BOOTSTRAP_DEADLINE_MS,
    };
    let ms = count(&limits["deadlineMs"], 1, cap)?;
    // T228 sends the activity events of `stallMs`.
    if let Some(stall) = limits.get("stallMs")
        && (kind != Kind::Registered || stall.as_u64() != Some(STALL_MS))
    {
        return Err(INVALID);
    }
    Ok(Duration::from_millis(ms))
}

fn count(value: &Value, min: u64, max: u64) -> Result<u64, Code> {
    value
        .as_u64()
        .filter(|n| (min..=max).contains(n))
        .ok_or(INVALID)
}

/// A base64 chunk with 1 to `max` decoded bytes.
fn chunk(value: &Value, max: usize) -> Result<Vec<u8>, Code> {
    value
        .as_str()
        .and_then(decode_base64)
        .filter(|bytes| (1..=max).contains(&bytes.len()))
        .ok_or(INVALID)
}

/// An absolute path with 1 to 32,767 UTF-16 units, no NUL, and no device prefix. A lone surrogate never decodes to a string.
pub(crate) fn path(value: &Value) -> Result<PathBuf, Code> {
    let text = value.as_str().ok_or(INVALID)?;
    let units = text.encode_utf16().count();
    let path = PathBuf::from(text);
    if units == 0
        || units > PATH_UNITS
        || text.contains('\0')
        || is_device_path(text)
        || !Path::is_absolute(&path)
    {
        return Err(INVALID);
    }
    Ok(path)
}

/// The device prefix `\\.\` or `\\?\` with either separator (contract §6 "Channel frames").
/// A device such as a pipe can block a read without end.
pub(crate) fn is_device_path(text: &str) -> bool {
    let separator = |byte: &u8| matches!(byte, b'\\' | b'/');
    match text.as_bytes() {
        [first, second, b'.' | b'?', third, ..] => {
            separator(first) && separator(second) && separator(third)
        }
        _ => false,
    }
}

pub(crate) fn identifier(value: &Value) -> Result<&str, Code> {
    value.as_str().filter(|id| is_identifier(id)).ok_or(INVALID)
}

/// A UUID-shaped lowercase ASCII identifier, as `src/contracts/operations.ts` `isIdentifier` checks it.
pub(crate) fn is_identifier(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (contract §6 "Channel frames").
fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = group
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= group.len() {
                BASE64[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// Decodes only the canonical padded form. Other text gives `None`.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let groups = bytes.len() / 4;
    let mut out = Vec::with_capacity(groups * 3);
    for (index, group) in bytes.chunks(4).enumerate() {
        let padding = group.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && index + 1 < groups) {
            return None;
        }
        let mut n = 0u32;
        for &b in &group[..4 - padding] {
            n = n << 6 | BASE64.iter().position(|&a| a == b)? as u32;
        }
        n <<= 6 * padding as u32;
        let decoded = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        if decoded[3 - padding..].iter().any(|&b| b != 0) {
            return None;
        }
        out.extend_from_slice(&decoded[..3 - padding]);
    }
    Some(out)
}

/// The contract §1 strict decoder, as `src/contracts/strict-json.ts` applies it: no duplicate key, at most 16 nested levels, no trailing data, and only safe integers.
/// A string value with a lone surrogate decodes to `null`. So no string field accepts it, and the frame keeps its `callId`.
pub(crate) fn decode_strict(text: &str) -> Option<Value> {
    let mut parser = Parser { text, at: 0 };
    let value = parser.value(0)?;
    parser.space();
    (parser.at == text.len()).then_some(value)
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.at += 1;
        Some(byte)
    }

    fn space(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.at += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        self.space();
        match self.peek()? {
            b'{' | b'[' if depth >= JSON_NESTING_LEVELS => None,
            b'{' => self.object(depth + 1),
            b'[' => self.array(depth + 1),
            b'"' => Some(self.string()?.map_or(Value::Null, Value::String)),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'n' => self.literal("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Option<Value> {
        self.text[self.at..].starts_with(word).then(|| {
            self.at += word.len();
            value
        })
    }

    fn array(&mut self, depth: usize) -> Option<Value> {
        self.at += 1;
        let mut out = Vec::new();
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Some(Value::Array(out));
        }
        loop {
            out.push(self.value(depth)?);
            self.space();
            match self.next()? {
                b']' => return Some(Value::Array(out)),
                b',' => {}
                _ => return None,
            }
        }
    }

    fn object(&mut self, depth: usize) -> Option<Value> {
        self.at += 1;
        let mut out = Map::new();
        self.space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Some(Value::Object(out));
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return None;
            }
            // A key with a lone surrogate fails the frame.
            let key = self.string()??;
            self.space();
            if self.next()? != b':' {
                return None;
            }
            let value = self.value(depth)?;
            if out.insert(key, value).is_some() {
                return None;
            }
            self.space();
            match self.next()? {
                b'}' => return Some(Value::Object(out)),
                b',' => {}
                _ => return None,
            }
        }
    }

    /// `Some(None)` is a well-formed string with a lone surrogate.
    fn string(&mut self) -> Option<Option<String>> {
        self.at += 1;
        let mut out = String::new();
        let mut lone = false;
        let mut segment = self.at;
        loop {
            match self.peek()? {
                b'"' => {
                    out.push_str(&self.text[segment..self.at]);
                    self.at += 1;
                    return Some((!lone).then_some(out));
                }
                0..=0x1f => return None,
                b'\\' => {
                    out.push_str(&self.text[segment..self.at]);
                    self.at += 1;
                    match self.next()? {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => match self.hex4()? {
                            high @ 0xd800..=0xdbff => {
                                let back = self.at;
                                let low = self.text[self.at..]
                                    .starts_with("\\u")
                                    .then(|| {
                                        self.at += 2;
                                        self.hex4()
                                    })
                                    .flatten();
                                match low {
                                    Some(low @ 0xdc00..=0xdfff) => out.push(char::from_u32(
                                        0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00),
                                    )?),
                                    _ => {
                                        lone = true;
                                        self.at = back;
                                    }
                                }
                            }
                            0xdc00..=0xdfff => lone = true,
                            unit => out.push(char::from_u32(unit)?),
                        },
                        _ => return None,
                    }
                    segment = self.at;
                }
                _ => self.at += 1,
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.text.get(self.at..self.at + 4)?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u32::from_str_radix(digits, 16).ok()
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        let digits = |p: &mut Self| {
            let from = p.at;
            while p.peek().is_some_and(|b| b.is_ascii_digit()) {
                p.at += 1;
            }
            p.at > from
        };
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        if self.peek() == Some(b'0') {
            self.at += 1;
        } else if !digits(self) {
            return None;
        }
        let mut integer = true;
        if self.peek() == Some(b'.') {
            self.at += 1;
            integer = false;
            if !digits(self) {
                return None;
            }
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.at += 1;
            integer = false;
            if let Some(b'+' | b'-') = self.peek() {
                self.at += 1;
            }
            if !digits(self) {
                return None;
            }
        }
        let text = &self.text[start..self.at];
        if integer {
            // Number.MAX_SAFE_INTEGER.
            let n: i64 = text.parse().ok()?;
            (n.unsigned_abs() < 1 << 53).then(|| Value::from(n))
        } else {
            serde_json::Number::from_f64(text.parse().ok()?).map(Value::Number)
        }
    }
}

#[cfg(test)]
mod strict_tests {
    use super::*;

    #[test]
    fn the_strict_decoder_and_the_base64_codec_follow_the_contract() {
        assert_eq!(
            decode_strict(r#"{"a":[1,-2.5,{"b":"é😀"}]}"#),
            Some(json!({ "a": [1, -2.5, { "b": "é😀" }] }))
        );
        for refused in [
            r#"{"a":1,"a":2}"#,
            r#"{"a":1} x"#,
            "9007199254740992",
            "[01]",
            r#""\x""#,
            r#"{"\ud800":1}"#,
        ] {
            assert_eq!(decode_strict(refused), None, "{refused}");
        }
        let nested = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
        assert!(decode_strict(&nested(16)).is_some(), "16 levels");
        assert_eq!(decode_strict(&nested(17)), None, "17 levels");
        assert_eq!(
            decode_strict(r#"["\ud800","\udc00x","\ud800A"]"#),
            Some(json!([null, null, null])),
            "a lone surrogate gives no string"
        );
        for bytes in [&b"a"[..], b"ab", b"abc", b"abcd"] {
            assert_eq!(decode_base64(&encode_base64(bytes)).as_deref(), Some(bytes));
        }
        for refused in ["", "YQ", "YR==", "Y===", "YQ==YQ==", "****"] {
            assert_eq!(decode_base64(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn a_channel_path_with_a_device_prefix_is_refused() {
        for device in [
            r"\\.\pipe\git",
            "//./pipe/git",
            r"\/.\C:\Git\cmd\git.exe",
            r"\\?\C:\Git\cmd\git.exe",
            r"\\?\UNC\server\share\git.exe",
            "//?/C:/Git/cmd/git.exe",
        ] {
            assert_eq!(path(&json!(device)), Err(INVALID), "{device}");
        }
        for accepted in [
            r"C:\repo",
            "C:/repo",
            r"\\server\share\repo",
            "//server/share/repo",
        ] {
            assert!(path(&json!(accepted)).is_ok(), "{accepted}");
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::io::Read;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Condvar, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use serde_json::{Map, Value, json};
    use windows::Win32::Foundation::ERROR_IO_PENDING;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_OVERLAPPED, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    use windows::Win32::System::IO::{DeviceIoControl, OVERLAPPED};
    use windows::Win32::System::Ioctl::FSCTL_REQUEST_BATCH_OPLOCK;
    use windows::Win32::System::Threading::CreateEventW;

    use crate::bootstrap::{ContextKind, read_identity};
    use crate::jobs::tests::{
        CHILD_PREFIX, CLOSE_BOUND, Fixture, Proc, WAIT, eventually, test_exe, wait_file,
    };

    /// The `register` digest of a test Git. The shell checks only its form.
    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
        /// Blocks only `inputWritten` replies while closed.
        input_gate: Arc<Gate>,
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
                Duration::from_millis(WALK_DEADLINE_MS),
            )
        }

        fn new(
            fixture: Fixture,
            argument_prefix: Vec<String>,
            base_environment: Vec<(OsString, OsString)>,
            walk_deadline: Duration,
        ) -> Harness {
            let contexts = Arc::new(Contexts::new(&uuid()));
            let jobs = Supervisor::start().expect("start the supervisor");
            let replies: Replies = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
            let gate = Arc::new(Gate {
                open: Mutex::new(true),
                changed: Condvar::new(),
            });
            let input_gate = Arc::new(Gate {
                open: Mutex::new(true),
                changed: Condvar::new(),
            });
            let sink: ReplySink = {
                let (replies, gate, input_gate) = (
                    Arc::clone(&replies),
                    Arc::clone(&gate),
                    Arc::clone(&input_gate),
                );
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
                    if reply["type"] == "inputWritten" {
                        input_gate.pass();
                    }
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
                walk_deadline,
            };
            let requests =
                ProcessRequests::new(config, Arc::clone(&contexts), Arc::clone(&jobs), sink);
            Harness {
                requests,
                contexts,
                jobs,
                replies,
                gate,
                input_gate,
                fixture,
            }
        }

        fn send(&self, inner: Value) {
            self.requests
                .handle(&json!({ "kind": "process", "process": inner }).to_string());
        }

        /// Handles the frame on another thread. False when the handler still runs after `bound`.
        fn send_within(&self, inner: Value, bound: Duration) -> bool {
            let requests = Arc::clone(&self.requests);
            let body = json!({ "kind": "process", "process": inner }).to_string();
            let (done, handled) = mpsc::channel();
            std::thread::spawn(move || {
                requests.handle(&body);
                let _ = done.send(());
            });
            handled.recv_timeout(bound).is_ok()
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

        /// Registers `program` as the saved Git, which needs no confirmation.
        fn register_git(&self, program: &Path) -> String {
            let bootstrap_id = self
                .contexts
                .create_startup(program, Instant::now())
                .expect("startup gitProbe context");
            let git = uuid();
            self.register(json!({ "bootstrapId": bootstrap_id, "gitInstallationId": git, "version": "2.55.0.windows.3", "digest": DIGEST, "confirm": false }));
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

        /// The shell side of a `started` reply with a marker ID for the workspace common directory.
        fn started(&self, operation: &str, workspace: &Workspace) {
            let common = workspace.worktree.join(".git");
            self.requests.tag(
                operation,
                crate::bootstrap::PhysicalIdentity::Windows(
                    read_identity(&common).expect("common-directory identity"),
                ),
            );
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.gate.set(true);
            self.input_gate.set(true);
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
        let call = uuid();
        let mut exec_path = probe(&call, &uuid(), &new_probe());
        exec_path["arguments"] = json!(["--exec-path"]);
        harness.send(exec_path);
        assert_eq!(harness.exit(&call, WAIT).expect("exit").1["exitCode"], 0);
        assert!(
            String::from_utf8_lossy(&harness.output(&call, "stdout")).contains("EXEC_PATH"),
            "the --exec-path probe runs"
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
                .create_startup(&test_exe(), Instant::now())
                .expect("context");
            json!({ "type": "register", "callId": call, "operationId": uuid(), "bootstrapId": bootstrap, "gitInstallationId": uuid(), "version": "2.55.0", "digest": DIGEST, "confirm": false })
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
            ("register without digest", remove("digest")),
            (
                "register with an uppercase digest",
                set("digest", json!(DIGEST.to_uppercase())),
            ),
            (
                "register with a 63-digit digest",
                set("digest", json!(&DIGEST[1..])),
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
    fn register_without_confirmation_binds_only_the_startup_context() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let plain = harness
            .contexts
            .create(ContextKind::GitProbe, &test_exe(), Instant::now())
            .expect("context");
        let call = uuid();
        let git = uuid();
        harness.send(json!({ "type": "register", "callId": call, "operationId": uuid(), "bootstrapId": plain, "gitInstallationId": git, "version": "2.55.0.windows.3", "digest": DIGEST, "confirm": false }));
        assert_eq!(harness.reply(&call), refused(&call, "INVALID_REQUEST"));
        let unbound = Workspace {
            git,
            repository: workspace.repository.clone(),
            worktree: workspace.worktree.clone(),
        };
        let run = uuid();
        harness.send(run_body(
            &run,
            &uuid(),
            &unbound,
            &["sleep", "10"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        assert_eq!(
            harness.reply(&run),
            refused(&run, "UNKNOWN_TARGET"),
            "the gitInstallationId stays unbound"
        );
        // `child_workspace` bound its Git through a startup context with `confirm: false`.
        let bound = harness.run(&uuid(), &workspace, &["sleep", "10"]);
        assert_eq!(harness.exit(&bound, WAIT).expect("exit").1["exitCode"], 0);
    }

    #[test]
    fn resolve_git_moves_a_git_probe_context_to_the_resolved_file() {
        let harness = Harness::child();
        let wrapper = harness.fixture.path("cmd").join("git.exe");
        let resolved = harness.fixture.path("git-core").join("git.exe");
        for file in [&wrapper, &resolved] {
            std::fs::create_dir_all(file.parent().expect("folder")).expect("mkdir");
            std::fs::copy(test_exe(), file).expect("copy");
        }
        let now = Instant::now();
        let candidate = harness
            .contexts
            .create(ContextKind::GitProbe, &wrapper, now)
            .expect("context");
        let operation = uuid();
        let call = uuid();
        harness.send(json!({ "type": "resolveGit", "callId": call, "operationId": operation, "bootstrapId": candidate, "executablePath": resolved }));
        let reply = harness.reply(&call);
        assert_eq!(reply["type"], "resolveGit", "{reply}");
        let moved = reply["bootstrapId"]
            .as_str()
            .expect("bootstrapId")
            .to_string();
        assert_eq!(
            reply,
            json!({ "type": "resolveGit", "callId": call, "bootstrapId": moved })
        );
        let context = harness.contexts.get(&moved, now).expect("new context");
        assert_eq!(
            context.path, resolved,
            "the new context binds the resolved file"
        );
        assert_eq!(context.kind, ContextKind::GitProbe);
        assert!(!context.startup, "the new context needs Use this Git");
        assert_eq!(
            context.selected, wrapper,
            "the new context keeps the selected path"
        );
        assert_eq!(
            harness.contexts.get(&candidate, now).err(),
            Some("UNKNOWN_TARGET"),
            "the candidate context is gone"
        );
        let probe = |call: &str, operation: &str, bootstrap: &str| {
            json!({
                "type": "run", "callId": call, "operationId": operation, "contextKind": "gitProbe", "bootstrapId": bootstrap,
                "arguments": ["version", "--build-options"], "environmentPolicy": "probe", "limits": { "deadlineMs": 30_000 },
            })
        };
        let other = uuid();
        harness.send(probe(&other, &uuid(), &moved));
        assert_eq!(
            harness.reply(&other),
            refused(&other, "UNKNOWN_TARGET"),
            "the operation that resolved it owns the new context"
        );
        let run = uuid();
        harness.send(probe(&run, &operation, &moved));
        assert_eq!(harness.exit(&run, WAIT).expect("exit").1["exitCode"], 0);
    }

    #[test]
    fn resolve_git_refuses_a_file_that_is_not_a_regular_git_exe_also_for_a_startup_context() {
        let harness = Harness::child();
        let resolved = harness.fixture.path("git-core").join("git.exe");
        std::fs::create_dir_all(resolved.parent().expect("folder")).expect("mkdir");
        std::fs::copy(test_exe(), &resolved).expect("copy");
        let other_name = harness.fixture.path("git-core").join("other.exe");
        std::fs::copy(test_exe(), &other_name).expect("copy");
        let folder = harness.fixture.path("folder").join("git.exe");
        std::fs::create_dir_all(&folder).expect("mkdir");
        let missing = harness.fixture.path("missing").join("git.exe");
        let directory = harness.fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let now = Instant::now();
        let plain = || {
            harness
                .contexts
                .create(ContextKind::GitProbe, &test_exe(), now)
                .expect("context")
        };
        let startup = || {
            harness
                .contexts
                .create_startup(&test_exe(), now)
                .expect("startup context")
        };
        let cases: Vec<(&str, String, &Path, &str)> = vec![
            (
                "a startup context and another file name",
                startup(),
                &other_name,
                "INVALID_REQUEST",
            ),
            (
                "a startup context and a folder",
                startup(),
                &folder,
                "INVALID_REQUEST",
            ),
            ("another file name", plain(), &other_name, "INVALID_REQUEST"),
            ("a folder", plain(), &folder, "INVALID_REQUEST"),
            ("a missing file", plain(), &missing, "INVALID_REQUEST"),
            (
                "a discovery context",
                harness
                    .contexts
                    .create(ContextKind::RepositoryDiscovery, &directory, now)
                    .expect("context"),
                &resolved,
                "UNKNOWN_TARGET",
            ),
        ];
        for (name, bootstrap, path, code) in cases {
            let call = uuid();
            harness.send(json!({ "type": "resolveGit", "callId": call, "operationId": uuid(), "bootstrapId": bootstrap, "executablePath": path }));
            assert_eq!(harness.reply(&call), refused(&call, code), "{name}");
            assert!(
                harness.contexts.get(&bootstrap, now).is_ok(),
                "{name}: the context stays"
            );
        }
    }

    /// Copies the test binary to `<fixture>\<folder>\git.exe`.
    fn git_copy(harness: &Harness, folder: &str) -> PathBuf {
        let path = harness.fixture.path(folder).join("git.exe");
        std::fs::create_dir_all(path.parent().expect("folder")).expect("mkdir");
        std::fs::copy(test_exe(), &path).expect("copy");
        path
    }

    #[test]
    fn a_startup_context_moves_to_a_new_resolved_git_exe_and_registers_and_saves_it_without_use_this_git()
     {
        let harness = Harness::child();
        let wrapper = git_copy(&harness, "Git\\cmd");
        // Git for Windows 2.56 moved from `mingw64` to `ucrt64`. The settings still name the old file.
        let upgraded = git_copy(&harness, "Git\\ucrt64\\libexec\\git-core");
        let saved = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&saved);
        harness.requests.set_startup_git(Box::new(move |git| {
            seen.lock().expect("saved").push(git);
        }));
        let now = Instant::now();
        let startup = harness
            .contexts
            .create_startup(&wrapper, now)
            .expect("startup context");
        let operation = uuid();
        let call = uuid();
        harness.send(json!({ "type": "resolveGit", "callId": call, "operationId": operation, "bootstrapId": startup, "executablePath": upgraded }));
        let reply = harness.reply(&call);
        let moved = reply["bootstrapId"]
            .as_str()
            .unwrap_or_else(|| panic!("{reply}"))
            .to_string();
        let context = harness.contexts.get(&moved, now).expect("new context");
        assert_eq!(
            (context.path, context.selected, context.startup),
            (upgraded.clone(), wrapper.clone(), true)
        );
        let git = uuid();
        let register = uuid();
        harness.send(json!({ "type": "register", "callId": register, "operationId": operation, "bootstrapId": moved, "gitInstallationId": git, "version": "2.56.0.windows.1", "digest": DIGEST, "confirm": false }));
        assert_eq!(
            harness.reply(&register),
            json!({ "type": "register", "callId": register, "result": "approved" }),
            "the moved startup context registers without Use this Git"
        );
        assert_eq!(
            *saved.lock().expect("saved"),
            [ConfirmedGit {
                selected_path: wrapper,
                executable_path: upgraded,
                version: "2.56.0.windows.1".to_string(),
                digest: DIGEST.to_string(),
            }]
        );
        assert_eq!(
            harness.requests.take_confirmed_git(&git),
            None,
            "a startup registration is no Use this Git approval"
        );
    }

    #[test]
    fn a_context_moved_from_a_plain_context_still_needs_use_this_git() {
        let harness = Harness::child();
        let wrapper = git_copy(&harness, "Git\\cmd");
        let resolved = git_copy(&harness, "Git\\ucrt64\\libexec\\git-core");
        let saved = Arc::new(Mutex::new(0));
        let seen = Arc::clone(&saved);
        harness.requests.set_startup_git(Box::new(move |_| {
            *seen.lock().expect("saved") += 1;
        }));
        let candidate = harness
            .contexts
            .create(ContextKind::GitProbe, &wrapper, Instant::now())
            .expect("context");
        let operation = uuid();
        let call = uuid();
        harness.send(json!({ "type": "resolveGit", "callId": call, "operationId": operation, "bootstrapId": candidate, "executablePath": resolved }));
        let reply = harness.reply(&call);
        let moved = reply["bootstrapId"]
            .as_str()
            .unwrap_or_else(|| panic!("{reply}"))
            .to_string();
        let register = uuid();
        harness.send(json!({ "type": "register", "callId": register, "operationId": operation, "bootstrapId": moved, "gitInstallationId": uuid(), "version": "2.56.0.windows.1", "digest": DIGEST, "confirm": false }));
        assert_eq!(
            harness.reply(&register),
            refused(&register, "INVALID_REQUEST")
        );
        assert_eq!(*saved.lock().expect("saved"), 0, "nothing is saved");
    }

    #[test]
    fn use_this_git_after_a_move_shows_and_keeps_the_selected_path_and_the_resolved_path() {
        let harness = Harness::child();
        let wrapper = git_copy(&harness, "cmd");
        let resolved = git_copy(&harness, "git-core");
        let shown = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&shown);
        harness
            .requests
            .set_git_confirmation(Box::new(move |selected, path, version| {
                seen.lock().expect("shown").push((
                    selected.to_path_buf(),
                    path.to_path_buf(),
                    version.to_string(),
                ));
                Registered::Approved
            }));
        let candidate = harness
            .contexts
            .create(ContextKind::GitProbe, &wrapper, Instant::now())
            .expect("context");
        let operation = uuid();
        let call = uuid();
        harness.send(json!({ "type": "resolveGit", "callId": call, "operationId": operation, "bootstrapId": candidate, "executablePath": resolved }));
        let reply = harness.reply(&call);
        let moved = reply["bootstrapId"]
            .as_str()
            .unwrap_or_else(|| panic!("{reply}"))
            .to_string();
        let git = uuid();
        let register = uuid();
        harness.send(json!({ "type": "register", "callId": register, "operationId": operation, "bootstrapId": moved, "gitInstallationId": git, "version": "2.55.0.windows.3", "digest": DIGEST, "confirm": true }));
        assert_eq!(
            harness.reply(&register),
            json!({ "type": "register", "callId": register, "result": "approved" })
        );
        let version = "2.55.0.windows.3".to_string();
        assert_eq!(
            *shown.lock().expect("shown"),
            [(wrapper.clone(), resolved.clone(), version.clone())]
        );
        assert_eq!(
            harness.requests.take_confirmed_git(&git),
            Some(ConfirmedGit {
                selected_path: wrapper,
                executable_path: resolved,
                version,
                digest: DIGEST.to_string(),
            })
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

    #[test]
    fn an_input_frame_for_a_call_without_streamed_input_is_refused_and_keeps_the_job() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let call = harness.run(&uuid(), &workspace, &["sleep", "2000"]);
        harness.output_line(&call, "stdout", "PID");
        harness.send(json!({ "type": "input", "callId": call, "data": encode(b"x") }));
        assert_eq!(
            harness
                .wait_reply(WAIT, |v| v["callId"] == call && v["type"] == "refused")
                .map(|r| r.1),
            Some(refused(&call, "INVALID_REQUEST"))
        );
        assert_eq!(
            harness.exit(&call, WAIT).expect("exit").1["exitCode"],
            0,
            "the Job stays open, so the child exits by itself"
        );
    }

    #[test]
    fn a_ninth_unacknowledged_input_chunk_is_refused_and_keeps_the_job() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let call = uuid();
        let mut body = run_body(
            &call,
            &uuid(),
            &workspace,
            &["slow-stdin", "2000"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        );
        let total = (QUEUED_CHUNKS_PER_STREAM + 1) * CHUNK_BYTES;
        body["inputBytes"] = json!(total);
        harness.send(body);
        harness.output_line(&call, "stdout", "PID");
        let chunk =
            json!({ "type": "input", "callId": call, "data": encode(&vec![b'i'; CHUNK_BYTES]) });
        // The child reads no stdin for 2 s, so no chunk gets `inputWritten` before the ninth.
        for _ in 0..=QUEUED_CHUNKS_PER_STREAM {
            harness.send(chunk.clone());
        }
        assert_eq!(
            harness
                .wait_reply(WAIT, |v| v["callId"] == call && v["type"] == "refused")
                .map(|r| r.1),
            Some(refused(&call, "INVALID_REQUEST"))
        );
        harness
            .wait_reply(WAIT, |v| v["callId"] == call && v["type"] == "inputWritten")
            .expect("inputWritten");
        harness.send(chunk);
        assert_eq!(
            harness.output_line(&call, "stdout", "STDIN"),
            total.to_string(),
            "the refused chunk counts toward no total"
        );
        assert_eq!(
            harness.exit(&call, WAIT).expect("exit").1["exitCode"],
            0,
            "the Job stays open, so the child exits by itself"
        );
    }

    #[test]
    fn an_input_written_reply_never_follows_the_exit_reply() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let call = uuid();
        let mut body = run_body(
            &call,
            &uuid(),
            &workspace,
            &["sleep", "500"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        );
        body["inputBytes"] = json!(1);
        harness.send(body);
        harness.output_line(&call, "stdout", "PID");
        harness.input_gate.set(false);
        harness.send(json!({ "type": "input", "callId": call, "data": encode(b"x") }));
        // The child exits while its `inputWritten` reply waits in the sink.
        let _ = harness.exit(&call, Duration::from_secs(3));
        harness.input_gate.set(true);
        harness
            .wait_reply(WAIT, |v| v["callId"] == call && v["type"] == "inputWritten")
            .expect("inputWritten");
        harness.exit(&call, WAIT).expect("exit");
        let replies = harness.replies_for(&call);
        let position = |kind: &str| {
            replies
                .iter()
                .position(|(_, v)| v["type"] == kind)
                .unwrap_or_else(|| panic!("no {kind} reply: {replies:?}"))
        };
        assert!(
            position("inputWritten") < position("exit"),
            "replies: {replies:?}"
        );
        assert_eq!(
            position("exit"),
            replies.len() - 1,
            "exit is the last reply"
        );
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
    fn ten_thousand_sequential_operations_leave_the_session_maps_bounded() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let program = test_exe();
        for _ in 0..10_000 {
            let read = uuid();
            let bootstrap = harness
                .contexts
                .create(ContextKind::GitProbe, &program, Instant::now())
                .expect("gitProbe context");
            let call = uuid();
            harness.send(json!({
                "type": "identity", "callId": call, "operationId": read, "contextKind": "gitProbe",
                "bootstrapId": bootstrap, "paths": [program],
            }));
            assert_eq!(harness.reply(&call)["type"], "identity");
            harness.contexts.destroy(&bootstrap);
            harness.send(json!({ "type": "closeJob", "operationId": read }));
            let mutation = uuid();
            harness.started(&mutation, &workspace);
            assert_eq!(harness.requests.ended(&mutation, false), Ok(()));
        }
        let state = harness.requests.state();
        assert!(state.inactive.len() <= INACTIVE_OPERATIONS, "inactive");
        assert!(state.owners.len() <= 1, "owners");
        assert!(state.started.is_empty(), "started");
        assert!(state.calls.is_empty(), "calls");
        assert!(state.walks.is_empty(), "walks");
        assert_eq!(harness.requests.active_walks(), 0, "walk threads");
    }

    #[test]
    fn an_ended_frame_for_an_empty_job_closes_it() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let call = harness.run(&operation, &workspace, &["sleep", "10"]);
        harness.exit(&call, WAIT).expect("exit");
        harness.started(&operation, &workspace);
        assert_eq!(harness.requests.ended(&operation, false), Ok(()));
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
        harness.started(&operation, &workspace);
        assert_eq!(harness.requests.ended(&operation, false), Ok(()));
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
        harness.started(&lingering, &workspace);
        assert_eq!(harness.requests.ended(&lingering, false), Ok(()));
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
    fn an_ended_frame_without_a_started_reply_changes_nothing() {
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
        assert_eq!(
            harness.requests.ended(&operation, false),
            Err("INVALID_REQUEST")
        );
        assert!(
            !harness.jobs.is_lingering(&operation),
            "a read Job never lingers"
        );
        harness.send(json!({ "type": "closeJob", "operationId": operation }));
        assert!(
            grandchild.exits_within(CLOSE_BOUND),
            "closeJob still ends the read Job"
        );
    }

    #[test]
    fn a_mutation_run_needs_a_started_reply_with_a_marker() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let operation = uuid();
        let mutation = |call: &str| {
            run_body(
                call,
                &operation,
                &workspace,
                &["sleep", "10"],
                "mutation",
                json!({ "deadlineMs": 30_000 }),
            )
        };
        let early = uuid();
        harness.send(mutation(&early));
        assert_eq!(
            harness.reply(&early),
            refused(&early, "INVALID_REQUEST"),
            "no started reply"
        );
        harness.started(&operation, &workspace);
        let call = uuid();
        harness.send(mutation(&call));
        assert_eq!(
            harness.exit(&call, WAIT).expect("exit").1["exitCode"],
            0,
            "after the started reply"
        );
        assert_eq!(harness.requests.ended(&operation, false), Ok(()));
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
        harness.requests.tag(
            &operation,
            crate::bootstrap::PhysicalIdentity::Windows(read_identity(&common).expect("identity")),
        );
        harness.exit(&call, WAIT).expect("exit");
        assert_eq!(harness.requests.ended(&operation, false), Ok(()));
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

    pub(crate) fn junction(link: &Path, target: &Path) -> bool {
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
        // Win32 `CreateFileW` refuses `<` in a name with `ERROR_INVALID_NAME`, which is no not-found result.
        let invalid = harness.fixture.path("a<b");
        let call = uuid();
        harness.send(json!({
            "type": "identity", "callId": call, "operationId": uuid(), "contextKind": "registeredOperation",
            "gitInstallationId": workspace.git, "repositoryId": workspace.repository,
            "paths": [target, link, held, harness.fixture.path("absent"), harness.fixture.path("absent").join("child"), invalid],
        }));
        let expected = read_identity(&target).expect("bootstrap identity").reply();
        let reply = harness.reply(&call);
        assert_eq!(reply["type"], "identity");
        let identities = reply["identities"].as_array().expect("identities");
        assert_eq!(identities.len(), 6, "one entry per path, in order");
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
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "absent" }),
            "ERROR_FILE_NOT_FOUND"
        );
        assert_eq!(
            identities[4],
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "absent" }),
            "ERROR_PATH_NOT_FOUND"
        );
        assert_eq!(
            identities[5],
            json!({ "code": "UNSUPPORTED_REPOSITORY" }),
            "another failed open"
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

    // ---- File facts (contract §6 "File facts") ----

    fn file_facts_body(call: &str, workspace: &Workspace, files: Value) -> Value {
        json!({
            "type": "fileFacts", "callId": call, "operationId": uuid(), "contextKind": "registeredOperation",
            "gitInstallationId": workspace.git, "repositoryId": workspace.repository, "digest": true, "files": files,
        })
    }

    /// Registers the test binary as Git and a repository with the three roots as given. Registration opens no root.
    fn register_roots(harness: &Harness, roots: [&str; 3]) -> Workspace {
        let git = harness.register_git(&test_exe());
        let worktree = harness.fixture.path(&uuid());
        std::fs::create_dir(&worktree).expect("discovery folder");
        let bootstrap_id = harness
            .contexts
            .create(ContextKind::RepositoryDiscovery, &worktree, Instant::now())
            .expect("discovery context");
        let repository = uuid();
        harness.register(json!({
            "bootstrapId": bootstrap_id, "gitInstallationId": git, "repositoryId": repository,
            "worktreeRoot": roots[0], "gitDirectory": roots[1], "commonDirectory": roots[2],
        }));
        Workspace {
            git,
            repository,
            worktree,
        }
    }

    #[test]
    fn file_fact_requests_that_break_a_field_rule_get_refused_invalid_request() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let entry = |path: Value| json!({ "root": "gitDirectory", "path": path });
        let files = |path: Value| set("files", json!([entry(path)]));
        let cases: Vec<(&str, Edit)> = vec![
            ("component ..", files(json!(["hooks", ".."]))),
            (r"component a\b", files(json!([r"a\b"]))),
            ("component x:y", files(json!(["x:y"]))),
            ("component nul", files(json!(["nul"]))),
            ("component x.", files(json!(["x."]))),
            (
                "component of 256 UTF-16 units",
                files(json!(["\u{1f600}".repeat(128)])),
            ),
            ("no component", files(json!([]))),
            ("a component that is no string", files(json!([1]))),
            (
                "root home",
                set("files", json!([{ "root": "home", "path": ["h.sh"] }])),
            ),
            (
                "an entry with another key",
                set(
                    "files",
                    json!([{ "root": "gitDirectory", "path": ["hooks"], "x": 1 }]),
                ),
            ),
            ("no entry", set("files", json!([]))),
            (
                "65 entries",
                set("files", json!(vec![entry(json!(["hooks"])); 65])),
            ),
            ("no digest", remove("digest")),
            ("digest that is no boolean", set("digest", json!(1))),
            (
                "a discovery context",
                both(
                    set("contextKind", json!("repositoryDiscovery")),
                    set("bootstrapId", json!(uuid())),
                ),
            ),
            ("an unknown field", set("extra", json!(1))),
            (
                "an operation ID that is no identifier",
                set("operationId", json!("x")),
            ),
        ];
        expect_refusals(
            &harness,
            |call| file_facts_body(call, &workspace, json!([entry(json!(["hooks"]))])),
            cases,
            "INVALID_REQUEST",
        );
    }

    #[test]
    fn an_unbound_or_released_repository_id_gets_unknown_target() {
        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let files = json!([{ "root": "gitDirectory", "path": ["hooks"] }]);
        let bound = uuid();
        harness.send(file_facts_body(&bound, &workspace, files.clone()));
        assert_eq!(
            harness.reply(&bound),
            json!({ "type": "fileFacts", "callId": bound, "facts": [{ "kind": "absent" }] })
        );
        let unbound = Workspace {
            git: workspace.git.clone(),
            repository: uuid(),
            worktree: workspace.worktree.clone(),
        };
        let call = uuid();
        harness.send(file_facts_body(&call, &unbound, files.clone()));
        assert_eq!(harness.reply(&call), refused(&call, "UNKNOWN_TARGET"));
        harness.send(json!({ "type": "release", "repositoryId": workspace.repository }));
        let released = uuid();
        harness.send(file_facts_body(&released, &workspace, files));
        assert_eq!(
            harness.reply(&released),
            refused(&released, "UNKNOWN_TARGET")
        );
    }

    #[test]
    fn a_file_facts_reply_holds_one_fact_per_entry_in_order_and_never_follows_a_junction() {
        use std::os::windows::fs::MetadataExt;

        let harness = Harness::child();
        let workspace = harness.child_workspace("repo");
        let hooks = workspace.worktree.join(".git").join("hooks");
        std::fs::create_dir(&hooks).expect("hooks");
        std::fs::write(hooks.join("pre-commit"), "abc").expect("hook");
        let outside = harness.fixture.path("outside");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::write(outside.join("pre-commit"), "outside").expect("outside hook");
        if !junction(&hooks.join("linked"), &outside) {
            println!("SKIP fileFacts junction: missing capability ntfs-junction (unverified)");
            return;
        }
        let call = uuid();
        harness.send(file_facts_body(
            &call,
            &workspace,
            json!([
                { "root": "gitDirectory", "path": ["hooks", "linked", "pre-commit"] },
                { "root": "worktreeRoot", "path": [".git", "hooks", "pre-commit"] },
            ]),
        ));
        let metadata = std::fs::metadata(hooks.join("pre-commit")).expect("metadata");
        assert_eq!(
            harness.reply(&call),
            json!({ "type": "fileFacts", "callId": call, "facts": [
                { "kind": "link", "component": 2, "tag": "junction", "target": format!(r"\??\{}", outside.display()), "relative": false },
                { "kind": "file", "size": 3, "lastWrite": metadata.last_write_time().to_string(), "digest": crate::file_facts::tests::ABC },
            ] })
        );
    }

    #[test]
    fn common_directory_reads_below_the_main_git_directory_after_a_linked_worktree_registration() {
        let harness = Harness::child();
        let common = harness.fixture.path("main").join(".git");
        let git_directory = common.join("worktrees").join("linked");
        let worktree = harness.fixture.path("linked");
        std::fs::create_dir_all(common.join("hooks")).expect("hooks");
        std::fs::create_dir_all(&git_directory).expect("worktree administration folder");
        std::fs::create_dir(&worktree).expect("linked worktree");
        std::fs::write(common.join("hooks").join("pre-commit"), "abc").expect("hook");
        std::fs::write(git_directory.join("commondir"), "../..\n").expect("commondir");
        let text = |path: &Path| path.to_str().expect("UTF-8 fixture path").to_string();
        let workspace = register_roots(
            &harness,
            [&text(&worktree), &text(&git_directory), &text(&common)],
        );
        let call = uuid();
        harness.send(file_facts_body(
            &call,
            &workspace,
            json!([
                { "root": "commonDirectory", "path": ["hooks", "pre-commit"] },
                { "root": "gitDirectory", "path": ["hooks", "pre-commit"] },
                { "root": "gitDirectory", "path": ["commondir"] },
                { "root": "worktreeRoot", "path": ["hooks"] },
            ]),
        ));
        let facts = harness.reply(&call)["facts"].clone();
        assert_eq!(facts[0]["digest"], crate::file_facts::tests::ABC, "{facts}");
        assert_eq!(facts[1], json!({ "kind": "absent" }), "{facts}");
        assert_eq!(facts[2]["size"], 6, "{facts}");
        assert_eq!(facts[3], json!({ "kind": "absent" }), "{facts}");
    }

    #[test]
    fn a_windows_git_never_reads_the_file_facts_of_a_wsl_repository() {
        let harness = Harness::child();
        for root in [
            r"\\wsl$\Ubuntu\home\u\repo",
            r"\\WSL.localhost\Ubuntu\home\u\repo",
        ] {
            let git_directory = format!(r"{root}\.git");
            let workspace = register_roots(&harness, [root, &git_directory, &git_directory]);
            let call = uuid();
            harness.send(file_facts_body(
                &call,
                &workspace,
                json!([{ "root": "gitDirectory", "path": ["hooks", "pre-commit"] }]),
            ));
            assert_eq!(
                harness.reply(&call),
                refused(&call, "INVALID_REQUEST"),
                "{root}"
            );
        }
    }

    /// Contract §11: a WSL repository never runs Git for Windows. No distro has this name, so no process reaches WSL.
    #[test]
    fn a_windows_git_never_runs_in_a_registered_wsl_repository() {
        let harness = Harness::child();
        let root = r"\\wsl.localhost\Arbareto-No-Distro\home\u\repo";
        let git_directory = format!(r"{root}\.git");
        let workspace = register_roots(&harness, [root, &git_directory, &git_directory]);
        let (call, operation) = (uuid(), uuid());
        harness.send(run_body(
            &call,
            &operation,
            &workspace,
            &["status"],
            "read",
            json!({ "deadlineMs": 30_000 }),
        ));
        assert_eq!(harness.reply(&call), refused(&call, "INVALID_REQUEST"));
        assert!(
            harness.jobs.job_handle(&operation).is_none(),
            "no Job, so no process"
        );
    }

    // ---- WSL frames (gaps.md W1 to W4) ----

    const WSL_GUID: &str = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";
    const WSL_PATH: &str = r"\\wsl.localhost\Ubuntu-24.04\home\u\repo";

    /// The reference distro probe output with Git 2.55.0 and the context path lines.
    fn wsl_probe_output(change: &[(&str, &str)]) -> String {
        let mut lines: Vec<(String, String)> = [
            ("path git", "/usr/bin/git"),
            ("magic git", "-"),
            ("path systemd-run", "/usr/bin/systemd-run"),
            ("magic systemd-run", "-"),
            ("path systemctl", "/usr/bin/systemctl"),
            ("magic systemctl", "-"),
            ("path setsid", "/usr/bin/setsid"),
            ("magic setsid", "-"),
            ("path stat", "/usr/bin/stat"),
            ("magic stat", "-"),
            ("path env", "/usr/bin/env"),
            ("magic env", "-"),
            ("path perl", "/usr/bin/perl"),
            ("magic perl", "-"),
            ("pathenv", "/usr/bin"),
            ("version", "git version 2.55.0"),
            ("gitfs", "ef53:fedc9aa3bd65bc57"),
            ("gitfile", "43750:4066232:1751487822"),
            ("selfs", "ef53:fedc9aa3bd65bc57"),
            ("selino", "4242"),
            ("selstat", "ok"),
            ("scope", "0"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (key, value) in change {
            if let Some(line) = lines.iter_mut().find(|(k, _)| k == key) {
                line.1 = value.to_string();
            }
        }
        lines.iter().map(|(k, v)| format!("{k} {v}\n")).collect()
    }

    /// Answers each WSL process of every operation with the next scripted output, and records the commands.
    #[derive(Clone, Default)]
    struct ScriptHost {
        outputs: Arc<Mutex<VecDeque<Option<wsl::Output>>>>,
        commands: Arc<Mutex<Vec<wsl::Command>>>,
        /// While true, each process waits before it records its command.
        held: Arc<(Mutex<bool>, Condvar)>,
        /// While set, each walk process is a sleeping test child in the operation Job, and the product wait ends it.
        slow: Arc<Mutex<Option<Arc<Supervisor>>>>,
        /// The operation of this host. `set_wsl_hosts` gives one host to each operation.
        operation: String,
    }

    impl ScriptHost {
        fn hold(&self, held: bool) {
            *self.held.0.lock().expect("held") = held;
            self.held.1.notify_all();
        }

        fn push(&self, exit_code: u32, stdout: &[u8]) {
            self.outputs
                .lock()
                .expect("outputs")
                .push_back(Some(wsl::Output {
                    exit_code: Some(exit_code),
                    stdout: stdout.to_vec(),
                }));
        }

        fn commands(&self) -> Vec<wsl::Command> {
            self.commands.lock().expect("commands").clone()
        }
    }

    impl wsl::Host for ScriptHost {
        fn run(&self, command: &wsl::Command) -> Option<wsl::Output> {
            let (held, changed) = &*self.held;
            let _ = changed
                .wait_timeout_while(held.lock().expect("held"), WAIT, |held| *held)
                .expect("held");
            self.commands
                .lock()
                .expect("commands")
                .push(command.clone());
            self.outputs
                .lock()
                .expect("outputs")
                .pop_front()
                .expect("scripted output")
        }

        fn keys(&self) -> Vec<wsl::Key> {
            vec![wsl::Key {
                guid: WSL_GUID.to_string(),
                name: "Ubuntu-24.04".to_string(),
                version: 2,
            }]
        }

        /// Records the Git command and starts nothing, so the `run` ends refused.
        fn start(
            &self,
            command: &wsl::Command,
        ) -> Result<crate::spawn::Spawned, crate::spawn::SpawnError> {
            self.commands
                .lock()
                .expect("commands")
                .push(command.clone());
            Err(crate::spawn::SpawnError::OwnershipFailed)
        }

        fn anchor(&self, command: &wsl::Command) -> Result<(), crate::spawn::SpawnError> {
            self.commands
                .lock()
                .expect("commands")
                .push(command.clone());
            Ok(())
        }

        fn run_walk(
            &self,
            command: &wsl::Command,
            cap: usize,
            deadline: Duration,
            stop: HANDLE,
        ) -> wsl::Ended {
            let slow = self.slow.lock().expect("slow").clone();
            let Some(jobs) = slow else {
                return wsl::Ended {
                    output: self.run(command),
                    deadline: false,
                };
            };
            self.commands
                .lock()
                .expect("commands")
                .push(command.clone());
            let arguments = crate::jobs::tests::child_arguments(&["sleep", "60000"]);
            let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
            let directory = std::env::temp_dir();
            let request = SpawnRequest {
                program: &test_exe(),
                arguments: &arguments,
                environment: &environment,
                current_dir: &directory,
                wsl: false,
                input: Input::Closed,
            };
            let spawned = jobs
                .with_job(&self.operation, |job| spawn(&request, job))
                .expect("operation Job")
                .expect("sleeping child");
            wsl::collect(spawned, cap, deadline, Some(stop))
        }
    }

    struct WslHarness {
        harness: Harness,
        host: ScriptHost,
        saved: Arc<Mutex<Vec<SavedWslGit>>>,
        confirmations: Arc<Mutex<Vec<String>>>,
    }

    fn wsl_harness(approve: bool) -> WslHarness {
        wsl_harness_with(approve, Harness::child())
    }

    fn wsl_harness_with(approve: bool, harness: Harness) -> WslHarness {
        let host = ScriptHost::default();
        let shared = host.clone();
        harness.requests.set_wsl_hosts(Box::new(move |operation| {
            let mut host = shared.clone();
            host.operation = operation.to_string();
            Box::new(host)
        }));
        let saved = Arc::new(Mutex::new(Vec::new()));
        let store = Arc::clone(&saved);
        harness
            .requests
            .set_wsl_store(Box::new(move |git| store.lock().expect("saved").push(git)));
        let confirmations = Arc::new(Mutex::new(Vec::new()));
        let shown = Arc::clone(&confirmations);
        harness
            .requests
            .set_wsl_confirmation(Box::new(move |distro, git, version| {
                shown
                    .lock()
                    .expect("shown")
                    .push(format!("{distro} {git} {version}"));
                approve
            }));
        WslHarness {
            harness,
            host,
            saved,
            confirmations,
        }
    }

    impl WslHarness {
        fn context(&self) -> String {
            self.harness
                .contexts
                .create(
                    ContextKind::RepositoryDiscovery,
                    Path::new(WSL_PATH),
                    Instant::now(),
                )
                .expect("pending WSL context")
        }

        fn probe(&self, operation: &str, bootstrap_id: &str) -> Value {
            let call = uuid();
            self.harness.send(json!({ "type": "wslProbe", "callId": call, "operationId": operation, "bootstrapId": bootstrap_id, "distro": "Ubuntu-24.04", "limits": { "deadlineMs": 60000 } }));
            self.harness
                .wait_reply(WAIT, |v| {
                    v["callId"] == call.as_str() && (v["type"] == "exit" || v["type"] == "refused")
                })
                .expect("exit")
                .1
        }

        fn register_git(&self, operation: &str, bootstrap_id: &str, git: &str) -> Value {
            let call = uuid();
            self.harness.send(json!({ "type": "register", "callId": call, "operationId": operation, "bootstrapId": bootstrap_id, "gitInstallationId": git, "confirm": true }));
            self.harness.reply(&call)
        }

        fn register_repository(
            &self,
            operation: &str,
            bootstrap_id: &str,
            git: &str,
            root: &str,
        ) -> Value {
            let call = uuid();
            let git_directory = format!(r"{root}\.git");
            self.harness.send(json!({ "type": "register", "callId": call, "operationId": operation, "bootstrapId": bootstrap_id, "gitInstallationId": git, "repositoryId": uuid(), "worktreeRoot": root, "gitDirectory": git_directory, "commonDirectory": git_directory }));
            self.harness.reply(&call)
        }
    }

    #[test]
    fn a_wsl_probe_binds_the_context_once_and_streams_its_output_as_run() {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id) = (uuid(), wsl.context());
        let output = wsl_probe_output(&[]);
        wsl.host.push(0, output.as_bytes());
        let exit = wsl.probe(&operation, &bootstrap_id);
        assert_eq!(exit["exitCode"], 0);
        let call = exit["callId"].as_str().expect("call").to_string();
        assert_eq!(wsl.harness.output(&call, "stdout"), output.as_bytes());
        // gaps.md W1: the probe gets the Linux path of the context as its one argument.
        let probe = &wsl.host.commands()[0];
        assert_eq!(
            probe.arguments,
            wsl::probe_command("Ubuntu-24.04", "/home/u/repo", &[]).arguments
        );
        assert_eq!(
            wsl.harness
                .contexts
                .get(&bootstrap_id, Instant::now())
                .expect("context")
                .identity,
            ContextIdentity::Wsl
        );
        // A second probe of a bound context is refused, and nothing runs.
        assert_eq!(
            wsl.probe(&operation, &bootstrap_id)["code"],
            "INVALID_REQUEST"
        );
        assert_eq!(wsl.host.commands().len(), 1);
    }

    /// gaps.md W1: the bind is reserved when the probe arrives, so a second probe in flight cannot bind the context again.
    #[test]
    fn a_second_wsl_probe_while_the_first_runs_is_refused_and_starts_nothing() {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id) = (uuid(), wsl.context());
        wsl.host.push(0, wsl_probe_output(&[]).as_bytes());
        wsl.host
            .push(0, wsl_probe_output(&[("selino", "9999")]).as_bytes());
        wsl.host.hold(true);
        let first = uuid();
        wsl.harness.send(json!({ "type": "wslProbe", "callId": first, "operationId": operation, "bootstrapId": bootstrap_id, "distro": "Ubuntu-24.04", "limits": { "deadlineMs": 60000 } }));
        let second = uuid();
        wsl.harness.send(json!({ "type": "wslProbe", "callId": second, "operationId": operation, "bootstrapId": bootstrap_id, "distro": "Ubuntu-24.04", "limits": { "deadlineMs": 60000 } }));
        let early = wsl
            .harness
            .wait_reply(Duration::from_secs(2), |v| v["callId"] == second.as_str())
            .map(|(_, v)| v);
        wsl.host.hold(false);
        assert_eq!(early, Some(refused(&second, "INVALID_REQUEST")));
        let exit = wsl
            .harness
            .wait_reply(WAIT, |v| {
                v["callId"] == first.as_str() && v["type"] == "exit"
            })
            .expect("exit")
            .1;
        assert_eq!(exit["exitCode"], 0);
        assert_eq!(wsl.host.commands().len(), 1);
        let state = wsl.harness.requests.state();
        let bound = state.wsl_bound.get(&bootstrap_id).expect("bound");
        assert_eq!(bound.identity.inode, "4242");
    }

    /// Per-context and per-operation WSL state leaves with its context and with its operation.
    #[test]
    fn the_bound_facts_leave_with_their_context_and_the_unit_counter_with_its_operation() {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        wsl.host.push(0, b"id 4242 ef53:fedc9aa3bd65bc57\n");
        let call = uuid();
        wsl.harness.send(json!({
            "type": "identity", "callId": call, "operationId": operation, "contextKind": "repositoryDiscovery",
            "bootstrapId": bootstrap_id, "gitInstallationId": git, "paths": [WSL_PATH],
        }));
        wsl.harness.reply(&call);
        assert!(
            wsl.harness
                .requests
                .state()
                .wsl_units
                .contains_key(&operation)
        );
        wsl.harness.contexts.destroy(&bootstrap_id);
        // Any later context request prunes the facts of a destroyed context.
        let (other_operation, other) = (uuid(), wsl.context());
        assert_eq!(
            wsl.register_git(&other_operation, &other, &uuid())["code"],
            "INVALID_REQUEST"
        );
        wsl.harness
            .send(json!({ "type": "closeJob", "operationId": operation }));
        let state = wsl.harness.requests.state();
        assert!(!state.wsl_bound.contains_key(&bootstrap_id), "bound facts");
        assert!(!state.wsl_units.contains_key(&operation), "unit counter");
    }

    // ---- WSL walks (T212 decision W9, contract §6 "Walks") ----

    /// A registered WSL repository. Each later walk process is a sleeping test child in its operation Job.
    fn slow_wsl_repository(wsl: &WslHarness) -> (String, String) {
        let (operation, bootstrap_id, git) = bound_wsl(wsl);
        wsl.host.push(0, b"id 4242 ef53:fedc9aa3bd65bc57\n");
        let (call, repository) = (uuid(), uuid());
        let git_directory = format!(r"{WSL_PATH}\.git");
        wsl.harness.send(json!({ "type": "register", "callId": call, "operationId": operation, "bootstrapId": bootstrap_id, "gitInstallationId": git, "repositoryId": repository, "worktreeRoot": WSL_PATH, "gitDirectory": git_directory, "commonDirectory": git_directory }));
        assert_eq!(wsl.harness.reply(&call)["result"], "approved");
        *wsl.host.slow.lock().expect("slow") = Some(Arc::clone(&wsl.harness.jobs));
        (git, repository)
    }

    fn wsl_facts_body(call: &str, operation: &str, git: &str, repository: &str) -> Value {
        json!({
            "type": "fileFacts", "callId": call, "operationId": operation, "contextKind": "registeredOperation",
            "gitInstallationId": git, "repositoryId": repository, "digest": false,
            "files": [{ "root": "gitDirectory", "path": ["hooks", "pre-commit"] }],
        })
    }

    /// True when the sleeping walk child of `operation` started in its Job.
    fn walk_child_started(wsl: &WslHarness, operation: &str) -> bool {
        eventually(WAIT, || {
            wsl.harness.jobs.active_processes(operation) == Some(1)
        })
    }

    #[test]
    fn a_wsl_walk_past_its_deadline_replies_deadline_and_its_wsl_exe_ends() {
        let harness = Harness::new(
            Fixture::new(),
            CHILD_PREFIX.iter().map(|s| s.to_string()).collect(),
            std::env::vars_os().collect(),
            Duration::from_secs(2),
        );
        let wsl = wsl_harness_with(true, harness);
        let (git, repository) = slow_wsl_repository(&wsl);
        let (call, operation) = (uuid(), uuid());
        wsl.harness
            .send(wsl_facts_body(&call, &operation, &git, &repository));
        assert_eq!(
            wsl.harness.reply(&call),
            json!({ "type": "fileFacts", "callId": call, "deadline": "deadline" })
        );
        assert!(
            eventually(CLOSE_WAIT, || wsl.harness.jobs.active_processes(&operation)
                == Some(0)),
            "the walk Event ends the wsl.exe process"
        );
        assert!(eventually(CLOSE_WAIT, || wsl
            .harness
            .requests
            .active_walks()
            == 0));
        assert!(
            wsl.harness.jobs.job_handle(&operation).is_some(),
            "the stop never closes the operation Job"
        );
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(wsl.harness.replies_for(&call).len(), 1, "one reply");
    }

    #[test]
    fn a_canceled_wsl_walk_sends_no_reply_and_its_wsl_exe_ends() {
        let wsl = wsl_harness(true);
        let (git, _) = slow_wsl_repository(&wsl);
        let (operation, bootstrap_id) = (uuid(), wsl.context());
        wsl.host.push(0, wsl_probe_output(&[]).as_bytes());
        // An identity request in a bound WSL context of another operation.
        *wsl.host.slow.lock().expect("slow") = None;
        wsl.probe(&operation, &bootstrap_id);
        *wsl.host.slow.lock().expect("slow") = Some(Arc::clone(&wsl.harness.jobs));
        let call = uuid();
        wsl.harness.send(json!({
            "type": "identity", "callId": call, "operationId": operation, "contextKind": "repositoryDiscovery",
            "bootstrapId": bootstrap_id, "gitInstallationId": git, "paths": [WSL_PATH],
        }));
        assert!(walk_child_started(&wsl, &operation), "the walk child runs");
        wsl.harness
            .send(json!({ "type": "cancel", "callId": call }));
        assert!(
            eventually(CLOSE_WAIT, || wsl.harness.jobs.active_processes(&operation)
                == Some(0)),
            "the walk Event ends the wsl.exe process"
        );
        assert!(eventually(CLOSE_WAIT, || wsl
            .harness
            .requests
            .active_walks()
            == 0));
        assert!(
            wsl.harness.jobs.job_handle(&operation).is_some(),
            "cancel never closes the operation Job"
        );
        std::thread::sleep(Duration::from_millis(500));
        assert!(wsl.harness.replies_for(&call).is_empty(), "no reply");
    }

    #[test]
    fn close_job_stops_a_wsl_walk_without_a_reply() {
        let wsl = wsl_harness(true);
        let (git, repository) = slow_wsl_repository(&wsl);
        let (call, operation) = (uuid(), uuid());
        wsl.harness
            .send(wsl_facts_body(&call, &operation, &git, &repository));
        assert!(walk_child_started(&wsl, &operation), "the walk child runs");
        wsl.harness
            .send(json!({ "type": "closeJob", "operationId": operation }));
        assert!(
            eventually(CLOSE_WAIT, || wsl.harness.requests.active_walks() == 0),
            "closeJob stops the walk"
        );
        std::thread::sleep(Duration::from_millis(500));
        assert!(wsl.harness.replies_for(&call).is_empty(), "no reply");
    }

    #[test]
    fn a_probe_that_fails_a_section_11_rule_binds_nothing_and_the_wsl_register_is_refused() {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id) = (uuid(), wsl.context());
        wsl.host
            .push(0, wsl_probe_output(&[("selstat", "absent")]).as_bytes());
        assert_eq!(wsl.probe(&operation, &bootstrap_id)["exitCode"], 0);
        assert_eq!(
            wsl.register_git(&operation, &bootstrap_id, &uuid())["code"],
            "INVALID_REQUEST"
        );
        assert!(wsl.confirmations.lock().expect("shown").is_empty());
    }

    #[test]
    fn use_this_git_issues_the_wsl_git_from_the_bound_facts_and_saves_it() {
        for approve in [true, false] {
            let wsl = wsl_harness(approve);
            let (operation, bootstrap_id) = (uuid(), wsl.context());
            wsl.host.push(0, wsl_probe_output(&[]).as_bytes());
            wsl.probe(&operation, &bootstrap_id);
            let git = uuid();
            let reply = wsl.register_git(&operation, &bootstrap_id, &git);
            assert_eq!(
                reply["result"],
                if approve { "approved" } else { "declined" }
            );
            assert_eq!(
                *wsl.confirmations.lock().expect("shown"),
                vec!["Ubuntu-24.04 /usr/bin/git 2.55.0".to_string()]
            );
            let saved = wsl.saved.lock().expect("saved").clone();
            if approve {
                assert_eq!(
                    saved,
                    vec![SavedWslGit {
                        guid: WSL_GUID.to_string(),
                        distro: "Ubuntu-24.04".to_string(),
                        git: "/usr/bin/git".to_string(),
                        version: "2.55.0".to_string(),
                        identity: "fedc9aa3bd65bc57:43750:4066232:1751487822".to_string(),
                    }]
                );
            } else {
                assert!(saved.is_empty(), "Cancel saves nothing");
            }
        }
    }

    /// A WSL context with the bound facts and an approved WSL Git.
    fn bound_wsl(wsl: &WslHarness) -> (String, String, String) {
        let (operation, bootstrap_id) = (uuid(), wsl.context());
        wsl.host.push(0, wsl_probe_output(&[]).as_bytes());
        wsl.probe(&operation, &bootstrap_id);
        let git = uuid();
        assert_eq!(
            wsl.register_git(&operation, &bootstrap_id, &git)["result"],
            "approved"
        );
        (operation, bootstrap_id, git)
    }

    #[test]
    fn the_repository_register_reads_the_context_identity_again_and_a_change_destroys_the_context()
    {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        wsl.host.push(0, b"id 4242 ef53:fedc9aa3bd65bc57\n");
        assert_eq!(
            wsl.register_repository(&operation, &bootstrap_id, &git, WSL_PATH)["result"],
            "approved"
        );
        let check = wsl.host.commands().last().expect("identity probe").clone();
        assert!(check.arguments.contains(&"/home/u/repo".to_string()));

        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        wsl.host.push(0, b"id 9999 ef53:fedc9aa3bd65bc57\n");
        let reply = wsl.register_repository(&operation, &bootstrap_id, &git, WSL_PATH);
        assert_eq!(reply["code"], "UNKNOWN_TARGET");
        assert!(
            wsl.harness
                .contexts
                .get(&bootstrap_id, Instant::now())
                .is_err(),
            "the context is destroyed"
        );

        // A path outside the bound distro is refused before any process.
        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        let before = wsl.host.commands().len();
        let outside = r"\\wsl.localhost\Debian\home\u\repo";
        assert_eq!(
            wsl.register_repository(&operation, &bootstrap_id, &git, outside)["code"],
            "INVALID_REQUEST"
        );
        assert_eq!(wsl.host.commands().len(), before);
    }

    #[test]
    fn a_wsl_identity_request_runs_one_identity_probe_and_answers_absent() {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        wsl.host.push(
            0,
            b"id 4242 ef53:fedc9aa3bd65bc57\nabsent\nid 7 1021997:1\n",
        );
        let call = uuid();
        wsl.harness.send(json!({
            "type": "identity", "callId": call, "operationId": operation, "contextKind": "repositoryDiscovery",
            "bootstrapId": bootstrap_id, "gitInstallationId": git,
            "paths": [WSL_PATH, format!(r"{WSL_PATH}\gone"), r"\\wsl.localhost\Ubuntu-24.04\mnt\c\r", r"C:\repo"],
        }));
        assert_eq!(
            wsl.harness.reply(&call)["identities"],
            json!([
                { "distroGuid": WSL_GUID, "fileSystemId": "fedc9aa3bd65bc57", "inode": "4242" },
                { "code": "UNSUPPORTED_REPOSITORY", "reason": "absent" },
                { "code": "UNSUPPORTED_REPOSITORY", "reason": "mixed-location" },
                { "code": "UNSUPPORTED_REPOSITORY" },
            ])
        );
        // The Windows path never reaches the probe.
        let probe = wsl.host.commands().last().expect("identity probe").clone();
        assert!(!probe.arguments.iter().any(|a| a.contains("C:")));
    }

    #[test]
    fn a_windows_git_cannot_run_in_a_wsl_context_and_a_wsl_git_runs_through_the_wrapper() {
        let wsl = wsl_harness(true);
        let windows_git = wsl.harness.register_git(&test_exe());
        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        let run = |git: &str, call: &str| {
            json!({
                "type": "run", "callId": call, "operationId": operation, "contextKind": "repositoryDiscovery",
                "bootstrapId": bootstrap_id, "gitInstallationId": git,
                "arguments": ["--no-lazy-fetch", "rev-parse", "--is-bare-repository"], "environmentPolicy": "probe",
                "limits": { "deadlineMs": 30000 },
            })
        };
        let call = uuid();
        wsl.harness.send(run(&windows_git, &call));
        assert_eq!(wsl.harness.reply(&call), refused(&call, "INVALID_REQUEST"));
        let installation = wsl
            .harness
            .requests
            .state()
            .wsl_bound
            .get(&bootstrap_id)
            .expect("bound")
            .installation
            .clone();
        let base = wsl.harness.requests.config.base_environment.clone();
        let git_command = |mode, operation: &str, n, arguments: &[&str]| {
            let arguments: Vec<String> = arguments.iter().map(|a| a.to_string()).collect();
            let unit = wsl::unit_name(operation, n).expect("unit");
            let command = wsl::git_command(
                &installation,
                mode,
                &unit,
                None,
                "/home/u/repo",
                &arguments,
                &base,
                wsl::Stdin::Closed,
            );
            command.expect("command").arguments
        };
        // The WSL Git of the context: the host gets the wrapper command in `probe` mode, and `-C` takes the Linux directory.
        let call = uuid();
        wsl.harness.send(run(&git, &call));
        assert_eq!(
            wsl.harness.reply(&call),
            refused(&call, "PROCESS_OWNERSHIP_FAILED"),
            "the script host starts nothing"
        );
        let arguments = ["--no-lazy-fetch", "rev-parse", "--is-bare-repository"];
        assert_eq!(
            wsl.host.commands().last().expect("Git").arguments,
            git_command(wsl::Mode::Probe, &operation, 1, &arguments)
        );

        // A mutation of a registered WSL repository starts its anchor before its first Git process.
        wsl.host.push(0, b"id 4242 ef53:fedc9aa3bd65bc57\n");
        let repository = uuid();
        let (register, git_directory) = (uuid(), format!(r"{WSL_PATH}\.git"));
        wsl.harness.send(json!({ "type": "register", "callId": register, "operationId": operation, "bootstrapId": bootstrap_id, "gitInstallationId": git, "repositoryId": repository, "worktreeRoot": WSL_PATH, "gitDirectory": git_directory, "commonDirectory": git_directory }));
        assert_eq!(wsl.harness.reply(&register)["result"], "approved");
        let mutation = uuid();
        let common = wsl::WslIdentity {
            guid: WSL_GUID.to_string(),
            file_system_id: "fedc9aa3bd65bc57".to_string(),
            inode: "4243".to_string(),
        };
        wsl.harness
            .requests
            .tag(&mutation, crate::bootstrap::PhysicalIdentity::Wsl(common));
        let before = wsl.host.commands().len();
        let arguments = ["--no-lazy-fetch", "commit", "--quiet"];
        let call = uuid();
        wsl.harness.send(json!({
            "type": "run", "callId": call, "operationId": mutation, "contextKind": "registeredOperation",
            "gitInstallationId": git, "repositoryId": repository, "arguments": arguments,
            "environmentPolicy": "mutation", "limits": { "deadlineMs": 30000 },
        }));
        assert_eq!(
            wsl.harness.reply(&call),
            refused(&call, "PROCESS_OWNERSHIP_FAILED")
        );
        let anchor = wsl::anchor_command(&installation, &mutation, &base).expect("anchor");
        let launched: Vec<Vec<String>> = wsl.host.commands()[before..]
            .iter()
            .map(|command| command.arguments.clone())
            .collect();
        assert_eq!(
            launched,
            vec![
                anchor.arguments,
                git_command(wsl::Mode::Mutation, &mutation, 1, &arguments)
            ]
        );
    }

    #[test]
    fn a_wsl_file_facts_request_runs_the_perl_probe_and_maps_its_records() {
        let wsl = wsl_harness(true);
        let (operation, bootstrap_id, git) = bound_wsl(&wsl);
        wsl.host.push(0, b"id 4242 ef53:fedc9aa3bd65bc57\n");
        let repository_call = uuid();
        let repository = uuid();
        let git_directory = format!(r"{WSL_PATH}\.git");
        wsl.harness.send(json!({ "type": "register", "callId": repository_call, "operationId": operation, "bootstrapId": bootstrap_id, "gitInstallationId": git, "repositoryId": repository, "worktreeRoot": WSL_PATH, "gitDirectory": git_directory, "commonDirectory": git_directory }));
        assert_eq!(wsl.harness.reply(&repository_call)["result"], "approved");
        wsl.host
            .push(0, b"absent\0file\x006\x001\x001\x001\x00none\0");
        let call = uuid();
        wsl.harness.send(json!({
            "type": "fileFacts", "callId": call, "operationId": uuid(), "contextKind": "registeredOperation",
            "gitInstallationId": git, "repositoryId": repository, "digest": false,
            "files": [{ "root": "gitDirectory", "path": ["hooks", "pre-commit"] }, { "root": "worktreeRoot", "path": ["run.sh"] }],
        }));
        assert_eq!(
            wsl.harness.reply(&call)["facts"],
            json!([
                { "kind": "absent" },
                { "kind": "file", "size": 6, "lastWrite": "1000000000", "executable": true, "ownerExecute": true },
            ])
        );
        let probe = wsl.host.commands().last().expect("Perl probe").clone();
        assert!(probe.arguments.contains(&"/usr/bin/perl".to_string()));
        assert!(probe.arguments.ends_with(&[
            "0".to_string(),
            "/home/u/repo".to_string(),
            "/home/u/repo/.git".to_string(),
            "/home/u/repo/.git".to_string()
        ]));
        let wsl::Stdin::Bytes(input) = &probe.stdin else {
            panic!("stdin bytes");
        };
        assert_eq!(
            input.as_slice(),
            b"1\x002\x00hooks\x00pre-commit\x000\x001\x00run.sh\x00"
        );
    }

    #[test]
    fn wsl_distros_replies_only_the_path_of_a_windows_context_and_starts_no_process() {
        let harness = Harness::child();
        let directory = harness.fixture.path("repo");
        std::fs::create_dir(&directory).expect("repo");
        let now = Instant::now();
        let bootstrap_id = harness
            .contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("discovery context");
        let (operation, call) = (uuid(), uuid());
        let frame = |call: &str, operation: &str, bootstrap_id: &str| json!({ "type": "wslDistros", "callId": call, "operationId": operation, "bootstrapId": bootstrap_id });
        harness.send(frame(&call, &operation, &bootstrap_id));
        assert_eq!(
            harness.reply(&call),
            json!({ "type": "wslDistros", "callId": call, "path": directory.to_str().expect("UTF-8") })
        );
        assert!(
            harness.jobs.job_handle(&operation).is_none(),
            "no Job, so no list call"
        );
        // Contract §6 "Context rules": the first operation owns the context.
        let other = uuid();
        harness.send(frame(&other, &uuid(), &bootstrap_id));
        assert_eq!(harness.reply(&other), refused(&other, "UNKNOWN_TARGET"));
        // A `gitProbe` context names no repository folder.
        let probe = harness
            .contexts
            .create(
                ContextKind::GitProbe,
                &std::env::current_exe().expect("test binary"),
                now,
            )
            .expect("gitProbe context");
        let wrong = uuid();
        harness.send(frame(&wrong, &uuid(), &probe));
        assert_eq!(harness.reply(&wrong), refused(&wrong, "UNKNOWN_TARGET"));
        // The generated type refuses a field outside the frame.
        let extra = uuid();
        let mut body = frame(&extra, &operation, &bootstrap_id);
        body["path"] = json!(r"C:\repo");
        harness.send(body);
        assert_eq!(harness.reply(&extra), refused(&extra, "INVALID_REQUEST"));
    }

    // ---- Walks (contract §6 "Walks") ----

    /// A batch oplock on one file (Microsoft Learn `FSCTL_REQUEST_BATCH_OPLOCK`).
    /// An open with only `FILE_READ_ATTRIBUTES` and `SYNCHRONIZE` breaks no batch oplock (MS-FSA 2.1.4.12).
    /// So only the digest data open of a walk waits on the break, until the holder closes its handle.
    struct Oplock {
        file: Option<File>,
        overlapped: Option<Box<OVERLAPPED>>,
        event: Owned,
    }

    impl Oplock {
        /// `None` when the file system grants no batch oplock.
        fn request(path: &Path) -> Option<Oplock> {
            use std::os::windows::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
                .custom_flags(FILE_FLAG_OVERLAPPED.0)
                .open(path)
                .ok()?;
            // SAFETY: a manual-reset event without a name and without security attributes.
            let event = Owned(unsafe { CreateEventW(None, true, false, None) }.ok()?);
            let mut overlapped = Box::new(OVERLAPPED {
                hEvent: event.0,
                ..Default::default()
            });
            // SAFETY: `file` is open for overlapped I/O. `overlapped` stays allocated until the request completes (Drop).
            let requested = unsafe {
                DeviceIoControl(
                    HANDLE(file.as_raw_handle()),
                    FSCTL_REQUEST_BATCH_OPLOCK,
                    None,
                    0,
                    None,
                    0,
                    None,
                    Some(&raw mut *overlapped),
                )
            };
            // Microsoft Learn: `ERROR_IO_PENDING` means that the oplock is granted.
            if requested.err()?.code() != ERROR_IO_PENDING.to_hresult() {
                return None;
            }
            Some(Oplock {
                file: Some(file),
                overlapped: Some(overlapped),
                event,
            })
        }

        /// True when an open broke the oplock within `timeout`.
        fn broken(&self, timeout: Duration) -> bool {
            wait(self.event.0, timeout)
        }
    }

    impl Drop for Oplock {
        /// The close releases each open that waits on the break.
        fn drop(&mut self) {
            drop(self.file.take());
            // The kernel writes the OVERLAPPED until the request completes.
            if !wait(self.event.0, CLOSE_WAIT) {
                std::mem::forget(self.overlapped.take());
            }
        }
    }

    /// A repository whose hooks folder holds each of `names` with the content "abc".
    fn hooks_workspace(harness: &Harness, names: &[&str]) -> Workspace {
        let workspace = harness.child_workspace("repo");
        std::fs::create_dir(workspace.worktree.join(".git").join("hooks")).expect("hooks");
        for name in names {
            std::fs::write(hook(&workspace, name), "abc").expect("hook");
        }
        workspace
    }

    fn hook(workspace: &Workspace, name: &str) -> PathBuf {
        workspace.worktree.join(".git").join("hooks").join(name)
    }

    fn hook_facts(call: &str, operation: &str, workspace: &Workspace, name: &str) -> Value {
        let mut body = file_facts_body(
            call,
            workspace,
            json!([{ "root": "gitDirectory", "path": ["hooks", name] }]),
        );
        body["operationId"] = json!(operation);
        body
    }

    /// Sends a digest walk of the hook under `oplock`. Returns once its data open waits on the break.
    fn blocked_walk(
        harness: &Harness,
        workspace: &Workspace,
        oplock: &Oplock,
        name: &str,
        operation: &str,
    ) -> String {
        let call = uuid();
        assert!(
            harness.send_within(hook_facts(&call, operation, workspace, name), CLOSE_WAIT),
            "the frame reader never waits on a walk"
        );
        assert!(
            oplock.broken(WAIT),
            "the data open of the walk waits on the oplock break"
        );
        call
    }

    const SKIP_OPLOCK: &str = "SKIP walk: missing capability batch-oplock (unverified)";

    #[test]
    fn a_walk_past_its_deadline_replies_deadline_and_no_fact() {
        // Only the held walk runs in this harness. Before its data open, it makes one root open, two relative opens, and two queries on a local volume.
        // So the walk blocks in that open long before the 2 s deadline.
        let harness = Harness::new(
            Fixture::new(),
            Vec::new(),
            Vec::new(),
            Duration::from_secs(2),
        );
        let workspace = hooks_workspace(&harness, &["held"]);
        let Some(oplock) = Oplock::request(&hook(&workspace, "held")) else {
            println!("{SKIP_OPLOCK}");
            return;
        };
        let call = blocked_walk(&harness, &workspace, &oplock, "held", &uuid());
        assert_eq!(
            harness.reply(&call),
            json!({ "type": "fileFacts", "callId": call, "deadline": "deadline" })
        );
        assert!(
            eventually(CLOSE_WAIT, || harness.requests.active_walks() == 0),
            "CancelSynchronousIo ends the wait on the oplock break (research U1)"
        );
        drop(oplock);
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            harness.replies_for(&call).len(),
            1,
            "the deadline reply is the only reply"
        );
    }

    #[test]
    fn a_canceled_walk_ends_without_a_reply() {
        let harness = Harness::child();
        let workspace = hooks_workspace(&harness, &["held", "free"]);
        let Some(oplock) = Oplock::request(&hook(&workspace, "held")) else {
            println!("{SKIP_OPLOCK}");
            return;
        };
        let call = blocked_walk(&harness, &workspace, &oplock, "held", &uuid());
        let free = uuid();
        harness.send(hook_facts(&free, &uuid(), &workspace, "free"));
        assert_eq!(
            harness.reply(&free)["facts"][0]["digest"],
            crate::file_facts::tests::ABC,
            "a second walk gets its fact while the first walk waits"
        );
        harness.send(json!({ "type": "cancel", "callId": call }));
        assert!(
            eventually(CLOSE_WAIT, || harness.requests.active_walks() == 0),
            "cancel stops the walk, and CancelSynchronousIo ends its wait on the oplock break (research U1)"
        );
        drop(oplock);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            harness.replies_for(&call).is_empty(),
            "a canceled walk gets no reply"
        );
    }

    #[test]
    fn close_job_stops_each_walk_of_its_operation_and_a_service_exit_stops_every_walk() {
        let harness = Harness::child();
        let workspace = hooks_workspace(&harness, &["closed", "other"]);
        let (Some(closed_lock), Some(other_lock)) = (
            Oplock::request(&hook(&workspace, "closed")),
            Oplock::request(&hook(&workspace, "other")),
        ) else {
            println!("{SKIP_OPLOCK}");
            return;
        };
        let operation = uuid();
        let closed = blocked_walk(&harness, &workspace, &closed_lock, "closed", &operation);
        let other = blocked_walk(&harness, &workspace, &other_lock, "other", &uuid());
        harness.send(json!({ "type": "closeJob", "operationId": operation }));
        assert!(
            eventually(CLOSE_WAIT, || harness.requests.active_walks() == 1),
            "closeJob stops the walk of its operation"
        );
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            harness.requests.active_walks(),
            1,
            "the walk of another operation still waits"
        );
        harness.requests.service_exited();
        assert!(
            eventually(CLOSE_WAIT, || harness.requests.active_walks() == 0),
            "a service exit stops every walk"
        );
        drop(closed_lock);
        drop(other_lock);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            harness.replies_for(&closed).is_empty() && harness.replies_for(&other).is_empty(),
            "a stopped walk gets no reply"
        );
    }

    #[test]
    fn a_cancel_after_the_walk_ended_but_before_its_reply_gives_no_reply() {
        let harness = Harness::child();
        let workspace = hooks_workspace(&harness, &["held"]);
        let Some(oplock) = Oplock::request(&hook(&workspace, "held")) else {
            println!("{SKIP_OPLOCK}");
            return;
        };
        let call = blocked_walk(&harness, &workspace, &oplock, "held", &uuid());
        // The seam: the state lock holds the watchdog after the walk ends.
        let state = harness.requests.state();
        drop(oplock);
        assert!(
            eventually(CLOSE_WAIT, || harness.requests.active_walks() == 0),
            "the walk ends after the oplock holder closes"
        );
        std::thread::sleep(Duration::from_millis(200));
        // `cancel` sends exactly this event under the state lock. The reader cannot run `cancel` while this test holds the lock.
        let _ = state.walks[call.as_str()].events.send(WalkEvent::Stop);
        drop(state);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            harness.replies_for(&call).is_empty(),
            "a cancel before the reply wins over a finished walk"
        );
        assert!(harness.requests.state().walks.is_empty(), "walks");
    }

    #[test]
    fn a_walk_whose_work_panics_ends_without_a_reply() {
        let harness = Harness::new(
            Fixture::new(),
            Vec::new(),
            Vec::new(),
            Duration::from_millis(300),
        );
        let call = uuid();
        let state = harness.requests.state();
        harness
            .requests
            .spawn_walk(state, "fileFacts", &call, &uuid(), Instant::now(), |_| {
                panic!("a test panic in a walk")
            })
            .expect("spawn the walk");
        assert!(
            eventually(CLOSE_WAIT, || harness.requests.active_walks() == 0),
            "the count drops at the panic"
        );
        // The wait passes the 300 ms deadline, so a deadline reply would arrive within it.
        std::thread::sleep(Duration::from_secs(1));
        assert!(
            harness.replies_for(&call).is_empty(),
            "a panic gives no reply and no deadline label"
        );
        assert!(harness.requests.state().walks.is_empty(), "walks");
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
            let harness = Harness::new(
                fixture,
                Vec::new(),
                environment.clone(),
                Duration::from_millis(WALK_DEADLINE_MS),
            );
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
            self.harness.started(operation, &self.workspace);
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
