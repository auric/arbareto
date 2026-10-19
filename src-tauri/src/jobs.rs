// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    CloseHandle, E_INVALIDARG, ERROR_MORE_DATA, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
};
use windows::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED, PostQueuedCompletionStatus,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectBasicAndIoAccountingInformation,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::SystemServices::JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO;
#[cfg(test)]
use windows::Win32::System::SystemServices::JOB_OBJECT_MSG_NEW_PROCESS;
use windows::core::{HRESULT, PCWSTR};

use crate::bootstrap::PhysicalIdentity;
use crate::spawn::SpawnError;
use crate::wsl;

/// No Job uses this completion key. A packet with it only wakes the port thread.
const WAKE_KEY: usize = 0;
/// Contract §6 "Activity and stall notice": the shell reads each activity sum once per second.
const SAMPLE_PERIOD: Duration = Duration::from_secs(1);

/// One Job object. It has kill-on-close and no breakaway, and its handle is not inheritable (contract §6).
pub struct Job {
    handle: HANDLE,
}

// SAFETY: the Job handle is a kernel handle that any thread can use. `Job` is its only owner.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn create() -> windows::core::Result<Job> {
        // SAFETY: no security attributes, so the new handle is not inheritable. `Job` owns it.
        let job = Job {
            handle: unsafe { CreateJobObjectW(None, PCWSTR::null()) }?,
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` matches the information class and the passed size.
        unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of_val(&limits) as u32,
            )
        }?;
        Ok(job)
    }

    pub fn handle(&self) -> HANDLE {
        self.handle
    }

    pub fn assign(&self, process: HANDLE) -> windows::core::Result<()> {
        // SAFETY: the caller keeps `process` open for the call, and `self` keeps the Job open.
        unsafe { AssignProcessToJobObject(self.handle, process) }
    }

    /// Ends every process in the Job at once. A start can still hold a clone of the Job, so the drop of the entry alone ends nothing.
    /// Kill-on-close still ends a process that such a start adds later.
    fn terminate(&self) {
        // SAFETY: `self` keeps the Job open for the call.
        let _ = unsafe { TerminateJobObject(self.handle, 1) };
    }

    fn accounting(&self) -> windows::core::Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` matches the information class and the passed size.
        unsafe {
            QueryInformationJobObject(
                Some(self.handle),
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                size_of_val(&info) as u32,
                None,
            )
        }?;
        Ok(info)
    }

    pub fn active_processes(&self) -> windows::core::Result<u32> {
        Ok(self.accounting()?.ActiveProcesses)
    }

    /// The sum of the six `IO_COUNTERS` fields of every process that was ever in the Job (contract §6 "Activity and stall notice").
    pub(crate) fn io_sum(&self) -> Option<u64> {
        let mut info = JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` matches the information class and the passed size.
        unsafe {
            QueryInformationJobObject(
                Some(self.handle),
                JobObjectBasicAndIoAccountingInformation,
                (&raw mut info).cast(),
                size_of_val(&info) as u32,
                None,
            )
        }
        .ok()?;
        let io = info.IoInfo;
        Some(
            [
                io.ReadOperationCount,
                io.WriteOperationCount,
                io.OtherOperationCount,
                io.ReadTransferCount,
                io.WriteTransferCount,
                io.OtherTransferCount,
            ]
            .into_iter()
            .fold(0u64, u64::wrapping_add),
        )
    }

    /// The count of every process that was ever in the Job.
    #[cfg(test)]
    pub fn total_processes(&self) -> windows::core::Result<u32> {
        Ok(self.accounting()?.TotalProcesses)
    }

    fn associate(&self, port: HANDLE, key: usize) -> windows::core::Result<()> {
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: key as *mut core::ffi::c_void,
            CompletionPort: port,
        };
        // SAFETY: `association` matches the information class and the passed size.
        unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectAssociateCompletionPortInformation,
                (&raw const association).cast(),
                size_of_val(&association) as u32,
            )
        }
    }

    /// The IDs of the processes in the Job. A list that does not fit is read again at the reported count, never cut.
    pub(crate) fn process_ids(&self) -> windows::core::Result<Vec<u32>> {
        let first = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
            / size_of::<usize>();
        let mut slots = 64;
        loop {
            let mut buffer = vec![0usize; first + slots];
            // SAFETY: `buffer` is aligned for the list and has the passed size in bytes.
            let result = unsafe {
                QueryInformationJobObject(
                    Some(self.handle),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * size_of::<usize>()) as u32,
                    None,
                )
            };
            // SAFETY: the buffer starts with the list header, which the call filled.
            let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let assigned = list.NumberOfAssignedProcesses as usize;
            let listed = list.NumberOfProcessIdsInList as usize;
            match result {
                Ok(()) if listed == assigned => {
                    return Ok(buffer[first..first + listed]
                        .iter()
                        .map(|&id| id as u32)
                        .collect());
                }
                Err(error) if error.code() != HRESULT::from_win32(ERROR_MORE_DATA.0) => {
                    return Err(error);
                }
                _ => slots = assigned.max(slots + 1),
            }
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: `Job` owns the handle and closes it once. Kill-on-close then ends every process in it.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// An activity event of contract §6 "Activity and stall notice" and §12 "Deadlines and Cancel".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Stalled,
    Active,
    /// The inactivity limit expired. No event follows.
    Inactivity,
}

/// The activity state of one tracked process. Activity is a forwarded output byte or a changed activity sum.
/// A lower sum counts too: the end of a WSL scope lowers the anchor sum (contract §6).
pub struct Activity {
    stall: Duration,
    inactivity: Option<Duration>,
    last: Instant,
    sum: Option<u64>,
    /// The last sample was unknown, so the next known sample is the new base (contract §6 "Unknown sample").
    unknown: bool,
    stalled: bool,
    /// No event follows: the limit expired, or the run ended.
    ended: bool,
    expired: bool,
}

impl Activity {
    pub fn new(now: Instant, stall: Duration, inactivity: Option<Duration>) -> Activity {
        Activity {
            stall,
            inactivity,
            last: now,
            sum: None,
            unknown: false,
            stalled: false,
            ended: false,
            expired: false,
        }
    }

    /// A forwarded output byte.
    pub fn output(&mut self, now: Instant) -> Option<Event> {
        self.active(now)
    }

    /// One sample of the activity sum. `None` is an unknown sample: it is neither activity nor idle time (contract §6 "Unknown sample").
    pub fn sample(&mut self, now: Instant, sum: Option<u64>) -> Option<Event> {
        let Some(new) = sum else {
            self.unknown = true;
            return None;
        };
        let old = self.sum.replace(new);
        if std::mem::take(&mut self.unknown) {
            self.last = now;
            return None;
        }
        if old.is_some_and(|old| old != new) {
            return self.active(now);
        }
        if self.ended {
            return None;
        }
        let idle = now.saturating_duration_since(self.last);
        if self.inactivity.is_some_and(|limit| idle >= limit) {
            self.ended = true;
            self.expired = true;
            Some(Event::Inactivity)
        } else if !self.stalled && idle >= self.stall {
            self.stalled = true;
            Some(Event::Stalled)
        } else {
            None
        }
    }

    fn active(&mut self, now: Instant) -> Option<Event> {
        if self.ended {
            return None;
        }
        self.last = now;
        std::mem::take(&mut self.stalled).then_some(Event::Active)
    }
}

/// One tracked process: its activity state and the sink of its events.
/// The sink runs under the state lock, so the events of one process keep their order.
pub struct Tracker {
    activity: Mutex<Activity>,
    sink: Box<dyn Fn(Event) + Send + Sync>,
}

impl Tracker {
    pub fn new(
        stall: Duration,
        inactivity: Option<Duration>,
        sink: impl Fn(Event) + Send + Sync + 'static,
    ) -> Arc<Tracker> {
        Arc::new(Tracker {
            activity: Mutex::new(Activity::new(Instant::now(), stall, inactivity)),
            sink: Box::new(sink),
        })
    }

    fn activity(&self) -> MutexGuard<'_, Activity> {
        self.activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn output(&self) {
        let mut activity = self.activity();
        if let Some(event) = activity.output(Instant::now()) {
            (self.sink)(event);
        }
    }

    fn sample(&self, sum: Option<u64>) {
        let mut activity = self.activity();
        if let Some(event) = activity.sample(Instant::now(), sum) {
            (self.sink)(event);
        }
    }

    /// True after the inactivity limit expired.
    pub fn expired(&self) -> bool {
        self.activity().expired
    }

    /// Ends the events of the process. Its run calls it before the exit reply.
    fn finish(&self) {
        self.activity().ended = true;
    }

    fn finished(&self) -> bool {
        self.activity().ended
    }
}

struct Port(HANDLE);

// SAFETY: the port handle is a kernel handle that any thread can use. `Port` is its only owner.
unsafe impl Send for Port {}
unsafe impl Sync for Port {}

impl Drop for Port {
    fn drop(&mut self) {
        // SAFETY: `Port` owns the handle and closes it once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct Entry {
    /// A start holds a clone, so a `close` during the start never waits for it.
    job: Arc<Job>,
    key: usize,
    tag: Option<PhysicalIdentity>,
    lingering: bool,
    #[cfg(test)]
    new_processes: Vec<u32>,
    /// The anchor of a WSL mutation (contract §11 "Process ownership").
    wsl: wsl::Mutation,
    /// The tracked processes of a Windows Job. The port thread samples them (contract §6 "Activity and stall notice").
    tracked: Vec<Arc<Tracker>>,
}

impl Entry {
    /// The lingering count. The accounting of a WSL Job counts `wsl.exe` processes, not Linux processes.
    /// So the last anchor count replaces it (contract §11 "Process ownership").
    fn count(&self) -> u32 {
        if self.wsl.has_anchor() {
            self.wsl.lingering_count()
        } else {
            self.job.active_processes().unwrap_or(0)
        }
    }
}

#[derive(Default)]
struct State {
    jobs: HashMap<String, Entry>,
    operations: HashMap<usize, String>,
    last_key: usize,
}

impl State {
    /// Ends every process of the Job, then drops the entry.
    fn remove(&mut self, operation_id: &str) {
        if let Some(entry) = self.jobs.remove(operation_id) {
            entry.job.terminate();
            self.operations.remove(&entry.key);
        }
    }

    /// Ends every process of each Job that `close` selects, then drops its entry.
    fn remove_where(&mut self, mut close: impl FnMut(&Entry) -> bool) {
        let (operations, jobs) = (&mut self.operations, &mut self.jobs);
        jobs.retain(|_, entry| {
            let keep = !close(entry);
            if !keep {
                entry.job.terminate();
                operations.remove(&entry.key);
            }
            keep
        });
    }

    fn lingering_with<'a>(&'a self, tag: &'a PhysicalIdentity) -> impl Iterator<Item = &'a Entry> {
        self.jobs
            .values()
            .filter(move |entry| entry.lingering && entry.tag.as_ref() == Some(tag))
    }
}

struct Shared {
    port: Port,
    state: Mutex<State>,
    stop: AtomicBool,
    drop_zero: AtomicBool,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_port(&self) {
        let mut next = Instant::now() + SAMPLE_PERIOD;
        while !self.stop.load(Ordering::SeqCst) {
            if Instant::now() >= next {
                next = Instant::now() + SAMPLE_PERIOD;
                self.sample();
            }
            // Contract §6 "Lingering Jobs": each wait lasts at most 1 second. It ends at the next sample.
            let wait = next.saturating_duration_since(Instant::now()).as_millis() as u32;
            let (mut message, mut key) = (0u32, 0usize);
            let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
            // SAFETY: the out pointers name live locals, and `self` keeps the port open.
            let result = unsafe {
                GetQueuedCompletionStatus(
                    self.port.0,
                    &mut message,
                    &mut key,
                    &mut overlapped,
                    wait,
                )
            };
            match result {
                Ok(()) => self.message(message, key, overlapped as usize as u32),
                Err(error) if error.code() == HRESULT::from_win32(WAIT_TIMEOUT.0) => {}
                Err(_) => return,
            }
        }
    }

    /// A Job message carries the process ID in the `lpOverlapped` value.
    #[cfg_attr(not(test), expect(unused_variables, reason = "test hook"))]
    fn message(&self, message: u32, key: usize, process_id: u32) {
        let mut state = self.state();
        let Some(operation_id) = state.operations.get(&key).cloned() else {
            return;
        };
        match message {
            #[cfg(test)]
            JOB_OBJECT_MSG_NEW_PROCESS => {
                if let Some(entry) = state.jobs.get_mut(&operation_id) {
                    entry.new_processes.push(process_id);
                }
            }
            JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
                if !self.drop_zero.load(Ordering::SeqCst)
                    && state.jobs.get(&operation_id).is_some_and(|e| e.lingering) =>
            {
                state.remove(&operation_id);
            }
            _ => {}
        }
    }

    /// Reads the I/O sum of each Job with a tracked process. The state lock is free while the sinks run.
    fn sample(&self) {
        let tracked: Vec<(Arc<Job>, Vec<Arc<Tracker>>)> = self
            .state()
            .jobs
            .values()
            .filter(|entry| !entry.tracked.is_empty())
            .map(|entry| (Arc::clone(&entry.job), entry.tracked.clone()))
            .collect();
        for (job, trackers) in tracked {
            let sum = job.io_sum();
            for tracker in trackers {
                tracker.sample(sum);
            }
        }
    }

    fn wake(&self) {
        // SAFETY: `self` keeps the port open. The packet carries no OVERLAPPED.
        let _ = unsafe { PostQueuedCompletionStatus(self.port.0, 0, WAKE_KEY, None) };
    }
}

fn is_empty(job: &Job) -> bool {
    matches!(job.active_processes(), Ok(0))
}

/// Owns the operation Jobs, the lingering set, and the completion-port thread (contract §6 "Lingering Jobs").
pub struct Supervisor {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    /// Creates the completion port and starts its reader thread.
    pub fn start() -> windows::core::Result<Arc<Supervisor>> {
        // SAFETY: a new port without a file handle. `Port` owns the returned handle.
        let port = Port(unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, None, 0, 1) }?);
        let shared = Arc::new(Shared {
            port,
            state: Mutex::new(State::default()),
            stop: AtomicBool::new(false),
            drop_zero: AtomicBool::new(false),
        });
        let reader = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("job-port".into())
            .spawn(move || reader.read_port())
            .map_err(|_| windows::core::Error::from_hresult(E_INVALIDARG))?;
        Ok(Arc::new(Supervisor {
            shared,
            thread: Mutex::new(Some(thread)),
        }))
    }

    /// Creates the Job of an operation and associates the port before any process joins.
    /// A second call for a running operation keeps its Job. A lingering Job refuses the call.
    pub fn open(&self, operation_id: &str) -> windows::core::Result<()> {
        let mut state = self.shared.state();
        if let Some(entry) = state.jobs.get(operation_id) {
            if entry.lingering {
                return Err(windows::core::Error::from_hresult(E_INVALIDARG));
            }
            return Ok(());
        }
        let job = Job::create()?;
        let key = state.last_key + 1;
        job.associate(self.shared.port.0, key)?;
        state.last_key = key;
        state.operations.insert(key, operation_id.to_string());
        state.jobs.insert(
            operation_id.to_string(),
            Entry {
                job: Arc::new(job),
                key,
                tag: None,
                lingering: false,
                #[cfg(test)]
                new_processes: Vec::new(),
                wsl: wsl::Mutation::default(),
                tracked: Vec::new(),
            },
        );
        Ok(())
    }

    /// Sets the common-directory identity tag of a mutation Job.
    pub fn tag(&self, operation_id: &str, tag: PhysicalIdentity) {
        if let Some(entry) = self.shared.state().jobs.get_mut(operation_id) {
            entry.tag = Some(tag);
        }
    }

    /// Runs `start` with the handle of a running operation Job, without the state lock.
    /// The image open of a process start can wait on an oplock break, and `close` must never wait for it (T314 D7).
    /// The clone keeps the Job open during `start`. After a `close`, the drop of the clone ends the new process.
    pub fn with_job<T>(
        &self,
        operation_id: &str,
        start: impl FnOnce(HANDLE) -> T,
    ) -> windows::core::Result<T> {
        let job = match self.shared.state().jobs.get(operation_id) {
            Some(entry) if !entry.lingering => Arc::clone(&entry.job),
            _ => return Err(windows::core::Error::from_hresult(E_INVALIDARG)),
        };
        Ok(start(job.handle()))
    }

    /// Starts the anchor of a WSL mutation in its running Job before the first execution process. A later call keeps that anchor.
    /// The start runs without the state lock, as in `with_job`. An anchor that finds its Job closed or anchored ends at once.
    pub fn start_anchor(
        &self,
        operation_id: &str,
        command: &wsl::Command,
        current_dir: &Path,
    ) -> Result<(), SpawnError> {
        let job = match self.shared.state().jobs.get(operation_id) {
            Some(entry) if !entry.lingering && entry.wsl.has_anchor() => return Ok(()),
            Some(entry) if !entry.lingering => Arc::clone(&entry.job),
            _ => return Err(SpawnError::OwnershipFailed),
        };
        let anchor = wsl::Anchor::start(command, job.handle(), current_dir)?;
        let mut state = self.shared.state();
        match state.jobs.get_mut(operation_id) {
            Some(entry) if !entry.lingering && Arc::ptr_eq(&entry.job, &job) => {
                if entry.wsl.has_anchor() {
                    anchor.end();
                    return Ok(());
                }
                entry.wsl.before_execution(|| Ok(anchor))
            }
            _ => {
                anchor.end();
                Err(SpawnError::OwnershipFailed)
            }
        }
    }

    /// Tracks the activity of a process in a running operation Job (contract §6 "Activity and stall notice").
    /// A WSL Job takes the sum only from its anchor, and one thread exchanges one anchor line each second.
    /// It never reads the `IO_COUNTERS` of a WSL Job, because the anchor exchange changes them.
    pub fn track(&self, operation_id: &str, tracker: &Arc<Tracker>) -> bool {
        let mut state = self.shared.state();
        let Some(entry) = state.jobs.get_mut(operation_id).filter(|e| !e.lingering) else {
            return false;
        };
        if !entry.wsl.has_anchor() {
            entry.tracked.push(Arc::clone(tracker));
            return true;
        }
        let (wsl, tracker) = (entry.wsl.clone(), Arc::clone(tracker));
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(SAMPLE_PERIOD);
                if tracker.finished() {
                    break;
                }
                tracker.sample(wsl.activity_sum());
            }
        });
        true
    }

    /// Ends the activity events of a process before its exit reply.
    pub fn untrack(&self, operation_id: &str, tracker: &Arc<Tracker>) {
        tracker.finish();
        if let Some(entry) = self.shared.state().jobs.get_mut(operation_id) {
            entry.tracked.retain(|t| !Arc::ptr_eq(t, tracker));
        }
    }

    /// Only a running operation Job takes a process.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only tests assign a process that std starts")
    )]
    pub fn assign(&self, operation_id: &str, process: HANDLE) -> windows::core::Result<()> {
        match self.shared.state().jobs.get(operation_id) {
            Some(entry) if !entry.lingering => entry.job.assign(process),
            _ => Err(windows::core::Error::from_hresult(E_INVALIDARG)),
        }
    }

    /// The open Job handle of an operation, or of a lingering Job.
    #[cfg_attr(not(test), expect(dead_code, reason = "only tests read Job handles"))]
    pub fn job_handle(&self, operation_id: &str) -> Option<HANDLE> {
        self.shared
            .state()
            .jobs
            .get(operation_id)
            .map(|entry| entry.job.handle())
    }

    /// The `activeDescendants` count after an execution process exits: the processes in the Job other than `exited`,
    /// or the anchor count of a WSL mutation (contract §6 "Lingering Jobs", §11 "Process ownership").
    /// The process handle can signal before Windows removes the process from the Job. So the count leaves out `exited` by its ID.
    /// The caller keeps the handle of `exited` open during the call, so its ID cannot identify another process.
    /// `None`: a closed Job, a failed query, or no fresh known anchor count. The exit reply then carries `null` (contract §6).
    pub fn active_descendants(&self, operation_id: &str, exited: Option<u32>) -> Option<u32> {
        let (ids, wsl) = {
            let state = self.shared.state();
            let entry = state.jobs.get(operation_id)?;
            (entry.job.process_ids(), entry.wsl.clone())
        };
        // The anchor answer can take up to the probe deadline, so the state lock is released first.
        if wsl.has_anchor() {
            return wsl.after_exit();
        }
        let ids = ids.ok()?;
        Some(ids.iter().filter(|&&id| Some(id) != exited).count() as u32)
    }

    /// The processes in the Job, or the anchor count of a WSL mutation.
    #[cfg(test)]
    pub fn active_processes(&self, operation_id: &str) -> Option<u32> {
        self.active_descendants(operation_id, None)
    }

    /// The IDs of the processes in the Job. Only tests read process IDs.
    #[cfg_attr(not(test), expect(dead_code, reason = "only tests read process IDs"))]
    pub fn process_ids(&self, operation_id: &str) -> Vec<u32> {
        let state = self.shared.state();
        state
            .jobs
            .get(operation_id)
            .map(|entry| entry.job.process_ids().expect("Job process IDs"))
            .unwrap_or_default()
    }

    /// The Job I/O sum of an operation, as the port thread reads it.
    #[cfg(test)]
    pub fn io_sum(&self, operation_id: &str) -> Option<u64> {
        let job = Arc::clone(&self.shared.state().jobs.get(operation_id)?.job);
        job.io_sum()
    }

    /// Closes the Job at once, with every descendant. Cancel, deadline, and `closeJob` use it.
    pub fn close(&self, operation_id: &str) {
        self.shared.state().remove(operation_id);
    }

    /// Handles an `ended` frame (contract §6 "Lingering Jobs").
    pub fn ended(&self, operation_id: &str, end_processes: bool) {
        let mut state = self.shared.state();
        let close = match state.jobs.get_mut(operation_id) {
            None => false,
            Some(entry) if end_processes || is_empty(&entry.job) => true,
            Some(entry) => {
                // The anchor exits at count 0 after its stdin closes. Its Job then empties.
                entry.wsl.ended();
                entry.lingering = true;
                is_empty(&entry.job)
            }
        };
        if close {
            state.remove(operation_id);
        }
        state.remove_where(|entry| entry.lingering && is_empty(&entry.job));
    }

    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only tests read the lingering state")
    )]
    pub fn is_lingering(&self, operation_id: &str) -> bool {
        self.shared
            .state()
            .jobs
            .get(operation_id)
            .is_some_and(|entry| entry.lingering)
    }

    /// True when a lingering Job has a WSL tag with this distro GUID (T314 D4).
    pub fn lingering_holds(&self, guid: &str) -> bool {
        self.shared.state().jobs.values().any(|entry| {
            entry.lingering
                && matches!(&entry.tag, Some(PhysicalIdentity::Wsl(tag)) if tag.guid == guid)
        })
    }

    /// The sum of the active process counts of the lingering Jobs with this tag.
    pub fn lingering_count(&self, tag: &PhysicalIdentity) -> u32 {
        let state = self.shared.state();
        state.lingering_with(tag).map(Entry::count).sum()
    }

    /// Closes the lingering Jobs with this tag. Returns their active process count before the close.
    pub fn revoke(&self, tag: &PhysicalIdentity) -> u32 {
        let mut state = self.shared.state();
        let count = state.lingering_with(tag).map(Entry::count).sum();
        state.remove_where(|entry| entry.lingering && entry.tag.as_ref() == Some(tag));
        count
    }

    /// Closes every operation Job outside the lingering set.
    pub fn service_exited(&self) {
        self.shared.state().remove_where(|entry| !entry.lingering);
    }

    /// Application close: closes the operation Jobs, then the lingering Jobs.
    pub fn close_all(&self) {
        let mut state = self.shared.state();
        state.remove_where(|entry| !entry.lingering);
        state.remove_where(|_| true);
    }

    /// Stops the port thread.
    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.wake();
        let thread = self
            .thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }

    /// Test hook: the process IDs of the `JOB_OBJECT_MSG_NEW_PROCESS` messages of a Job.
    #[cfg(test)]
    pub fn observed_new_processes(&self, operation_id: &str) -> Vec<u32> {
        self.shared
            .state()
            .jobs
            .get(operation_id)
            .map(|entry| entry.new_processes.clone())
            .unwrap_or_default()
    }

    /// Test hook: the count of answer lines of the anchor of the Job.
    #[cfg(test)]
    pub fn anchor_answers(&self, operation_id: &str) -> u64 {
        self.shared
            .state()
            .jobs
            .get(operation_id)
            .map_or(0, |entry| entry.wsl.line_facts().1)
    }

    /// Test hook: drops every `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` message while set.
    #[cfg_attr(not(test), expect(dead_code, reason = "test hook"))]
    pub fn drop_zero_messages(&self, drop: bool) {
        self.shared.drop_zero.store(drop, Ordering::SeqCst);
    }
}

/// The port thread stops and then drops the last `Shared`, which closes every Job.
impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.wake();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bootstrap::Identity;
    use crate::settings::hex;

    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use windows::Win32::Foundation::{
        CloseHandle, DUPLICATE_HANDLE_OPTIONS, DuplicateHandle, GENERIC_READ, GENERIC_WRITE,
        GetHandleInformation, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_NAME_NORMALIZED, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFinalPathNameByHandleW, OPEN_EXISTING,
    };
    use windows::Win32::System::JobObjects::{
        IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_BASIC_PROCESS_ID_LIST,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject,
    };
    use windows::Win32::System::SystemServices::JOB_OBJECT_ASSIGN_PROCESS;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    };
    use windows::core::{BOOL, w};

    // ---- Child process harness. The spawn and process request tests reuse it. ----

    /// libtest runs only `child_entry`. The child mode and its arguments follow the final `--`.
    pub(crate) const CHILD_PREFIX: [&str; 6] = [
        "jobs::tests::child_entry",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
        "--",
    ];

    pub(crate) const WAIT: Duration = Duration::from_secs(10);
    pub(crate) const CLOSE_BOUND: Duration = Duration::from_secs(5);

    pub(crate) fn test_exe() -> PathBuf {
        std::env::current_exe().expect("current_exe")
    }

    pub(crate) fn child_arguments(mode: &[&str]) -> Vec<String> {
        CHILD_PREFIX
            .iter()
            .chain(mode)
            .map(|s| s.to_string())
            .collect()
    }

    #[expect(dead_code, reason = "no test passes a wide path yet")]
    pub(crate) fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// A process handle. Drop terminates the process.
    pub(crate) struct Proc {
        pub(crate) handle: HANDLE,
        pub(crate) pid: u32,
    }

    impl Proc {
        pub(crate) fn open(pid: u32) -> Proc {
            let access =
                PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
            let handle = unsafe { OpenProcess(access, false, pid) }.expect("OpenProcess");
            Proc { handle, pid }
        }

        /// `None` when the process is gone.
        pub(crate) fn try_open(pid: u32) -> Option<Proc> {
            let access =
                PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
            unsafe { OpenProcess(access, false, pid) }
                .ok()
                .map(|handle| Proc { handle, pid })
        }

        pub(crate) fn exits_within(&self, timeout: Duration) -> bool {
            exits_within(self.handle, timeout)
        }
    }

    impl Drop for Proc {
        fn drop(&mut self) {
            unsafe {
                let _ = TerminateProcess(self.handle, 1);
                let _ = CloseHandle(self.handle);
            }
        }
    }

    pub(crate) fn exits_within(handle: HANDLE, timeout: Duration) -> bool {
        unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) == WAIT_OBJECT_0 }
    }

    /// The exit code of `ends_by_test`. A Job close ends its processes with code 1.
    pub(crate) const TEST_END: u32 = 0x7E57;

    /// Ends a running process with `TEST_END`. True only when no earlier termination began.
    /// Windows refuses a second termination with `ERROR_ACCESS_DENIED` and keeps the first exit code.
    pub(crate) fn ends_by_test(handle: HANDLE) -> bool {
        let mut code = 0;
        // SAFETY: the caller keeps the handle open for the calls.
        unsafe { TerminateProcess(handle, TEST_END) }.is_ok()
            && exits_within(handle, CLOSE_BOUND)
            && unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok()
            && code == TEST_END
    }

    /// Polls `condition` every 50 ms until it holds or `timeout` passes.
    pub(crate) fn eventually(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if condition() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Lines of a stream. A thread drains the stream to its end, so a writer never blocks.
    pub(crate) struct Lines(Receiver<String>);

    /// The longest kept line. A `REPORT` line of 64 KiB stdin holds 128 KiB of hex.
    const LINE_BYTES: usize = 1024 * 1024;

    impl Lines {
        pub(crate) fn new(mut reader: impl Read + Send + 'static) -> Lines {
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                let mut chunk = vec![0u8; 64 * 1024];
                let mut line = Vec::new();
                while let Ok(n) = reader.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    for &byte in &chunk[..n] {
                        if byte == b'\n' {
                            let _ =
                                sender.send(String::from_utf8_lossy(&line).trim_end().to_string());
                            line.clear();
                        } else if line.len() < LINE_BYTES {
                            line.push(byte);
                        }
                    }
                }
            });
            Lines(receiver)
        }

        /// The next line, or `None` after `timeout`.
        pub(crate) fn line(&self, timeout: Duration) -> Option<String> {
            self.0.recv_timeout(timeout).ok()
        }

        /// Returns the text after the first `<prefix> ` marker. libtest can print its own text before the marker on the same line.
        pub(crate) fn wait(&self, prefix: &str, timeout: Duration) -> String {
            let marker = format!("{prefix} ");
            let deadline = Instant::now() + timeout;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.0.recv_timeout(left) {
                    Ok(line) => {
                        if let Some(at) = line.find(&marker) {
                            return line[at + marker.len()..].to_string();
                        }
                    }
                    Err(_) => panic!("no `{prefix}` line within {timeout:?}"),
                }
            }
        }
    }

    /// A child started with `std::process::Command`. It waits for `go` on stdin before it starts a grandchild.
    pub(crate) struct Started {
        pub(crate) child: Child,
        pub(crate) stdin: Option<ChildStdin>,
        pub(crate) lines: Lines,
    }

    impl Started {
        pub(crate) fn handle(&self) -> HANDLE {
            HANDLE(self.child.as_raw_handle())
        }

        pub(crate) fn go(&mut self) {
            let mut stdin = self.stdin.take().expect("stdin");
            stdin.write_all(b"go\n").expect("write go");
        }
    }

    impl Drop for Started {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    pub(crate) fn start_child(mode: &[&str]) -> Started {
        let mut child = Command::new(test_exe())
            .args(child_arguments(mode))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child");
        let stdin = child.stdin.take();
        let lines = Lines::new(child.stdout.take().expect("stdout"));
        Started {
            child,
            stdin,
            lines,
        }
    }

    /// An owned fixture folder in the temporary directory. Drop removes it within `CLOSE_BOUND`.
    pub(crate) struct Fixture(pub(crate) PathBuf);

    impl Fixture {
        pub(crate) fn new() -> Fixture {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let name = format!(
                "arbareto-fixtures-{}-{}-{}",
                std::process::id(),
                nanos,
                NEXT.fetch_add(1, Ordering::SeqCst)
            );
            let path = std::env::temp_dir().join(name);
            std::fs::create_dir(&path).expect("create fixture folder");
            Fixture(path)
        }

        pub(crate) fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // A closed Job ends its processes asynchronously. A process that still runs in the folder keeps it in use.
            eventually(CLOSE_BOUND, || {
                std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists()
            });
        }
    }

    /// Waits until a file holds non-empty text that starts with `prefix`.
    pub(crate) fn wait_file(path: &Path, prefix: &str, timeout: Duration) -> Option<String> {
        let mut text = None;
        eventually(timeout, || {
            text = std::fs::read_to_string(path)
                .ok()
                .filter(|t| !t.is_empty() && t.starts_with(prefix));
            text.is_some()
        });
        text
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        // `GetConsoleWindow` lives in the `Win32_System_Console` feature, which T006 does not enable.
        fn GetConsoleWindow() -> *mut core::ffi::c_void;
    }

    fn print_line(line: &str) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    fn spawn_self(mode: &[&str], inherit_output: bool) -> Child {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(test_exe());
        command.args(child_arguments(mode)).stdin(Stdio::null());
        // A child without a console starts its children with DETACHED_PROCESS, as Git does (compat/mingw.c:2247-2263).
        // Otherwise each grandchild gets a new console, and its conhost.exe joins the Job.
        if unsafe { GetConsoleWindow() }.is_null() {
            command.creation_flags(windows::Win32::System::Threading::DETACHED_PROCESS.0);
        }
        if !inherit_output {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        command.spawn().expect("spawn grandchild")
    }

    fn write_chunks(
        out: &mut dyn Write,
        total: usize,
        byte: u8,
        mut after_chunk: impl FnMut(usize),
    ) -> std::io::Result<()> {
        let chunk = vec![byte; 64 * 1024];
        let mut written = 0;
        while written < total {
            let n = (total - written).min(chunk.len());
            out.write_all(&chunk[..n])?;
            out.flush()?;
            written += n;
            after_chunk(written);
        }
        Ok(())
    }

    fn read_go_line() {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }

    fn conout_opens() -> bool {
        let access = (GENERIC_READ | GENERIC_WRITE).0;
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
        match unsafe {
            CreateFileW(
                w!("CONOUT$"),
                access,
                share,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
        } {
            Ok(handle) => {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                true
            }
            Err(_) => false,
        }
    }

    /// The process IDs of the immediate Job of the calling process, or `None` outside a Job.
    fn own_job_process_ids() -> Option<Vec<u32>> {
        const SLOTS: usize = 64;
        let mut buffer = vec![0usize; 2 + SLOTS];
        let size = (buffer.len() * size_of::<usize>()) as u32;
        unsafe {
            QueryInformationJobObject(
                None,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                size,
                None,
            )
        }
        .ok()?;
        let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
        let ids = unsafe {
            std::slice::from_raw_parts(
                list.ProcessIdList.as_ptr(),
                list.NumberOfProcessIdsInList as usize,
            )
        };
        Some(ids.iter().map(|&id| id as u32).collect())
    }

    pub(crate) fn final_path(handle: HANDLE) -> Option<String> {
        let mut buffer = vec![0u16; 32_768];
        let n = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, FILE_NAME_NORMALIZED) }
            as usize;
        (n > 0 && n < buffer.len()).then(|| String::from_utf16_lossy(&buffer[..n]))
    }

    pub(crate) fn same_path(a: &str, b: &str) -> bool {
        let strip = |s: &str| s.trim_start_matches(r"\\?\").to_lowercase();
        strip(a) == strip(b)
    }

    /// Runs one child mode. Each mode exits the process, so libtest prints nothing after it.
    // Grandchildren must outlive this child, so it never waits for them.
    #[allow(clippy::zombie_processes)]
    fn run_child(mode: &str, args: &[String]) -> ! {
        let pid = std::process::id();
        match mode {
            // sleep <ms>
            "sleep" => {
                print_line(&format!("PID {pid}"));
                std::thread::sleep(Duration::from_millis(args[0].parse().expect("ms")));
            }
            // grandchild <count> <grandchild ms> <exit|stay>: waits for one stdin line, then starts the grandchildren.
            "grandchild" => {
                print_line(&format!("PID {pid}"));
                read_go_line();
                for _ in 0..args[0].parse::<usize>().expect("count") {
                    let grandchild = spawn_self(&["sleep", &args[1]], false);
                    print_line(&format!("GRANDCHILD {}", grandchild.id()));
                }
                if args[2] == "stay" {
                    std::thread::sleep(Duration::from_secs(60));
                }
            }
            // report <args...>: arguments, image, console state, and all stdin bytes.
            "report" => {
                let exe = std::env::current_exe()
                    .expect("current_exe")
                    .to_string_lossy()
                    .into_owned();
                let conout = conout_opens();
                let console_window_null = unsafe { GetConsoleWindow() }.is_null();
                let start = Instant::now();
                let mut input = Vec::new();
                let _ = std::io::stdin().read_to_end(&mut input);
                let report = serde_json::json!({
                    "pid": pid,
                    "exe": exe,
                    "args": args,
                    "conout": conout,
                    "consoleWindowNull": console_window_null,
                    "stdinHex": hex(&input),
                    "stdinEofMs": start.elapsed().as_millis() as u64,
                });
                print_line(&format!("REPORT {report}"));
            }
            // started <file>: writes the file first, then reports the processes of its immediate Job.
            "started" => {
                std::fs::write(&args[0], "started").expect("write started file");
                let ids = own_job_process_ids();
                print_line(&format!(
                    "STARTED {}",
                    serde_json::json!({ "pid": pid, "jobPids": ids })
                ));
            }
            // marker <handle value> <path>: reports whether the handle value names the marker file.
            "marker" => {
                let value: usize = args[0].parse().expect("handle value");
                let named = final_path(HANDLE(value as *mut core::ffi::c_void))
                    .is_some_and(|p| same_path(&p, &args[1]));
                print_line(&format!(
                    "MARKER {}",
                    serde_json::json!({ "inherited": named })
                ));
            }
            // write <stdout|stderr> <bytes> <progress file>: records the written total after each chunk.
            "write" => {
                let total: usize = args[1].parse().expect("bytes");
                let progress = PathBuf::from(&args[2]);
                let record = |written: usize| {
                    let _ = std::fs::write(&progress, written.to_string());
                };
                let result = if args[0] == "stdout" {
                    write_chunks(&mut std::io::stdout(), total, b'o', record)
                } else {
                    write_chunks(&mut std::io::stderr(), total, b'e', record)
                };
                result.expect("write");
            }
            // both <bytes>: writes stderr first, then stdout.
            "both" => {
                let total: usize = args[0].parse().expect("bytes");
                write_chunks(&mut std::io::stderr(), total, b'e', |_| {}).expect("stderr");
                write_chunks(&mut std::io::stdout(), total, b'o', |_| {}).expect("stdout");
            }
            // pipe-holder <delay ms> <bytes> <result file> <exit file>: a grandchild inherits stdout and stderr and writes after this exit.
            // The exit file receives the Unix time in milliseconds just before the exit.
            "pipe-holder" => {
                read_go_line();
                print_line(&format!("CHILD {pid}"));
                print_line("BEFORE stdout");
                let _ = writeln!(std::io::stderr(), "BEFORE stderr");
                let grandchild = spawn_self(&["late-writer", &args[0], &args[1], &args[2]], true);
                print_line(&format!("GRANDCHILD {}", grandchild.id()));
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_millis();
                std::fs::write(&args[3], now.to_string()).expect("write exit file");
            }
            // emit <text> <code>: writes the text to stderr without a line end and exits with the code.
            // libtest writes its own lines to stdout, so only stderr holds exact bytes.
            "emit" => {
                let mut stderr = std::io::stderr();
                stderr.write_all(args[0].as_bytes()).expect("stderr");
                stderr.flush().expect("flush");
                std::process::exit(args[1].parse().expect("code"));
            }
            // version: the output of a Git version probe.
            "version" => {
                print_line("git version 2.55.0.windows.3");
            }
            // --exec-path: marks the output of a Git exec-path probe.
            "--exec-path" => {
                print_line("EXEC_PATH");
            }
            // late-writer <delay ms> <bytes> <result file>: writes to both inherited streams, records the result, then stays.
            "late-writer" => {
                std::thread::sleep(Duration::from_millis(args[0].parse().expect("ms")));
                let total: usize = args[1].parse().expect("bytes");
                let start = Instant::now();
                let result = write_chunks(&mut std::io::stdout(), total, b'g', |_| {})
                    .and_then(|()| write_chunks(&mut std::io::stderr(), total, b'g', |_| {}));
                let text = match result {
                    Ok(()) => format!("ok {}", start.elapsed().as_millis()),
                    Err(error) => format!("err {error}"),
                };
                std::fs::write(&args[2], text).expect("write result file");
                std::thread::sleep(Duration::from_secs(60));
            }
            // suspended: starts a sleeping grandchild in its own Job, reports its PID, and stops before the resume.
            "suspended" => {
                let job = Job::create().expect("Job");
                let program = test_exe();
                let arguments = child_arguments(&["sleep", "60000"]);
                let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
                let current_dir = std::env::temp_dir();
                let request = crate::spawn::SpawnRequest {
                    program: &program,
                    arguments: &arguments,
                    environment: &environment,
                    current_dir: &current_dir,
                    wsl: false,
                    input: crate::spawn::Input::Closed,
                };
                let suspended =
                    crate::spawn::create_suspended(&request, job.handle()).expect("create");
                print_line(&format!("GRANDCHILD {}", suspended.pid));
                std::thread::sleep(Duration::from_secs(60));
            }
            // io <file> <delay ms> <period ms> <count>: no output after its PID line. After the delay, it writes 4 KiB to the file each period.
            "io" => {
                print_line(&format!("PID {pid}"));
                let ms = |text: &String| Duration::from_millis(text.parse().expect("ms"));
                std::thread::sleep(ms(&args[1]));
                for _ in 0..args[3].parse::<usize>().expect("count") {
                    std::fs::write(&args[0], [0u8; 4096]).expect("write the io file");
                    std::thread::sleep(ms(&args[2]));
                }
            }
            // late <ms>: prints its PID line, waits without I/O, then prints `LATE`.
            "late" => {
                print_line(&format!("PID {pid}"));
                std::thread::sleep(Duration::from_millis(args[0].parse().expect("ms")));
                print_line("LATE");
            }
            // env <names...>: the value of each name, or null.
            "env" => {
                let values: serde_json::Map<String, serde_json::Value> = args
                    .iter()
                    .map(|name| {
                        let value = std::env::var_os(name)
                            .map(|value| value.to_string_lossy().into_owned());
                        (name.clone(), serde_json::json!(value))
                    })
                    .collect();
                print_line(&format!("ENV {}", serde_json::Value::Object(values)));
            }
            // clone <options...> <url> <destination>: the feature 003 clone array. Creates `<destination>\.git` and reports the
            // arguments, the working folder, and the PuTTY pair. A URL that ends with `/fail.git` exits 128 and creates nothing.
            "clone" => {
                let destination = PathBuf::from(args.last().expect("destination"));
                let url = &args[args.len() - 2];
                let report = serde_json::json!({
                    "args": args,
                    "cwd": std::env::current_dir().expect("cwd"),
                    "sshCommand": std::env::var("GIT_SSH_COMMAND").ok(),
                    "sshVariant": std::env::var("GIT_SSH_VARIANT").ok(),
                });
                print_line(&format!("CLONE {report}"));
                if url.ends_with("/fail.git") {
                    std::process::exit(128);
                }
                std::fs::create_dir_all(destination.join(".git")).expect("clone folder");
            }
            // gui <ms>: a message-only window and a message loop, so `WaitForInputIdle` returns 0. Exits after the delay.
            "gui" => {
                use windows::Win32::UI::WindowsAndMessaging::{
                    CreateWindowExW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, SetTimer,
                    WINDOW_EX_STYLE, WINDOW_STYLE, WM_TIMER,
                };
                let window = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        windows::core::w!("STATIC"),
                        windows::core::w!(""),
                        WINDOW_STYLE(0),
                        0,
                        0,
                        0,
                        0,
                        Some(HWND_MESSAGE),
                        None,
                        None,
                        None,
                    )
                }
                .expect("message-only window");
                let ms: u32 = args[0].parse().expect("ms");
                unsafe { SetTimer(Some(window), 1, ms, None) };
                let mut message = MSG::default();
                while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
                    if message.message == WM_TIMER {
                        break;
                    }
                    unsafe { DispatchMessageW(&message) };
                }
            }
            // slow-stdin <ms>: reads stdin only after the delay.
            "slow-stdin" => {
                print_line(&format!("PID {pid}"));
                std::thread::sleep(Duration::from_millis(args[0].parse().expect("ms")));
                let mut input = Vec::new();
                let _ = std::io::stdin().read_to_end(&mut input);
                print_line(&format!("STDIN {}", input.len()));
            }
            _ => panic!("unknown child mode {mode}"),
        }
        std::process::exit(0)
    }

    #[test]
    #[ignore = "child process entry for re-executed tests"]
    fn child_entry() {
        let args: Vec<OsString> = std::env::args_os().collect();
        let Some(split) = args.iter().position(|a| a == "--") else {
            return;
        };
        let mut payload: Vec<String> = args[split + 1..]
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        if payload.first().map(String::as_str) == Some("--no-lazy-fetch") {
            payload.remove(0);
        }
        let Some((mode, rest)) = payload.split_first() else {
            return;
        };
        run_child(mode, rest)
    }

    // ---- T023 Job tests ----

    fn tag(n: u8) -> PhysicalIdentity {
        PhysicalIdentity::Windows(Identity {
            volume_serial: 0x4474_2150_7421_4650,
            file_id: [n; 16],
        })
    }

    /// Starts a child in the Job of `operation_id`. The child starts `count` sleeping grandchildren, then exits or stays.
    fn child_in_job(
        supervisor: &Supervisor,
        operation_id: &str,
        count: usize,
        then: &str,
    ) -> (Started, Vec<Proc>) {
        let mut child = start_child(&["grandchild", &count.to_string(), "60000", then]);
        supervisor
            .assign(operation_id, child.handle())
            .expect("assign the child");
        child.go();
        let grandchildren = (0..count)
            .map(|_| Proc::open(child.lines.wait("GRANDCHILD", WAIT).parse().expect("pid")))
            .collect();
        if then == "exit" {
            assert!(
                exits_within(child.handle(), WAIT),
                "the child exits by itself"
            );
            let pid = child.child.id();
            assert!(
                eventually(WAIT, || !supervisor
                    .process_ids(operation_id)
                    .contains(&pid)),
                "the Job no longer lists the exited child"
            );
        }
        (child, grandchildren)
    }

    fn assert_kill_on_close_without_breakaway(job: HANDLE) {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        unsafe {
            QueryInformationJobObject(
                Some(job),
                JobObjectExtendedLimitInformation,
                (&raw mut info).cast(),
                size,
                None,
            )
        }
        .expect("QueryInformationJobObject");
        let flags = info.BasicLimitInformation.LimitFlags;
        assert!(
            flags.contains(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
            "kill-on-close"
        );
        assert!(
            !flags.contains(JOB_OBJECT_LIMIT_BREAKAWAY_OK),
            "no breakaway"
        );
        assert!(
            !flags.contains(JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK),
            "no silent breakaway"
        );
    }

    fn inheritable(handle: HANDLE) -> bool {
        let mut flags = 0u32;
        unsafe { GetHandleInformation(handle, &mut flags) }.expect("GetHandleInformation");
        flags & HANDLE_FLAG_INHERIT.0 != 0
    }

    #[test]
    fn each_job_kills_on_close_without_breakaway() {
        let service = Job::create().expect("service Job");
        assert_kill_on_close_without_breakaway(service.handle());
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-limits").expect("open");
        assert_kill_on_close_without_breakaway(
            supervisor.job_handle("op-limits").expect("Job handle"),
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn job_handles_are_not_inheritable() {
        let service = Job::create().expect("service Job");
        assert!(!inheritable(service.handle()), "service Job handle");
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-inherit").expect("open");
        assert!(
            !inheritable(supervisor.job_handle("op-inherit").expect("Job handle")),
            "operation Job handle"
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn closing_an_operation_job_ends_its_child_and_grandchild() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-close").expect("open");
        let (child, grandchildren) = child_in_job(&supervisor, "op-close", 1, "stay");
        supervisor.close("op-close");
        assert!(
            exits_within(child.handle(), CLOSE_BOUND),
            "the child ends within 5 s"
        );
        assert!(
            grandchildren[0].exits_within(CLOSE_BOUND),
            "the grandchild ends within 5 s"
        );
        assert!(
            supervisor.job_handle("op-close").is_none(),
            "the handle is closed"
        );
        supervisor.shutdown();
    }

    #[test]
    fn close_never_waits_for_a_start_and_ends_the_process_that_the_start_makes() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-start").expect("open");
        let (entered, started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let starter = {
            let supervisor = Arc::clone(&supervisor);
            std::thread::spawn(move || {
                supervisor
                    .with_job("op-start", |job| {
                        let _ = entered.send(());
                        // The seam: a start whose image open waits.
                        let _ = released.recv_timeout(WAIT);
                        let arguments = child_arguments(&["sleep", "60000"]);
                        crate::spawn::spawn(
                            &crate::spawn::SpawnRequest {
                                program: &test_exe(),
                                arguments: &arguments,
                                environment: &std::env::vars_os().collect::<Vec<_>>(),
                                current_dir: &std::env::temp_dir(),
                                wsl: false,
                                input: crate::spawn::Input::Closed,
                            },
                            job,
                        )
                        .expect("a child in the Job")
                        .process
                        .0 as usize
                    })
                    .expect("a running Job")
            })
        };
        started.recv_timeout(WAIT).expect("the start runs");
        let (closed, done) = mpsc::channel();
        {
            let supervisor = Arc::clone(&supervisor);
            std::thread::spawn(move || {
                supervisor.close("op-start");
                let _ = closed.send(());
            });
        }
        assert!(
            done.recv_timeout(CLOSE_BOUND).is_ok(),
            "close does not wait for the start (T314 D7)"
        );
        release.send(()).expect("release");
        let process = HANDLE(starter.join().expect("starter") as *mut core::ffi::c_void);
        assert!(
            exits_within(process, CLOSE_BOUND),
            "the process of a start after the close ends with the Job"
        );
        // SAFETY: the test owns the process handle and closes it once.
        let _ = unsafe { CloseHandle(process) };
        supervisor.shutdown();
    }

    #[test]
    fn close_ends_the_running_processes_of_a_job_that_a_start_still_holds() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-held").expect("open");
        let (sleeper, _) = child_in_job(&supervisor, "op-held", 0, "stay");
        let (entered, started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let holder = {
            let supervisor = Arc::clone(&supervisor);
            std::thread::spawn(move || {
                supervisor
                    .with_job("op-held", |_| {
                        let _ = entered.send(());
                        // The seam: a start whose image open waits.
                        let _ = released.recv_timeout(WAIT);
                    })
                    .expect("a running Job");
            })
        };
        started.recv_timeout(WAIT).expect("the start runs");
        supervisor.close("op-held");
        assert!(
            exits_within(sleeper.handle(), CLOSE_BOUND),
            "close ends the processes that run already (T314 review fix 1)"
        );
        release.send(()).expect("release");
        holder.join().expect("holder");
        supervisor.shutdown();
    }

    #[test]
    fn closing_one_job_leaves_the_process_of_another_job_running() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-first").expect("open");
        supervisor.open("op-second").expect("open");
        let (first, _) = child_in_job(&supervisor, "op-first", 0, "stay");
        let (second, _) = child_in_job(&supervisor, "op-second", 0, "stay");
        supervisor.close("op-first");
        assert!(
            exits_within(first.handle(), CLOSE_BOUND),
            "the first child ends"
        );
        assert!(
            ends_by_test(second.handle()),
            "the close of the first Job never began to end the second child"
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn an_unrelated_process_with_the_same_executable_survives() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-unrelated").expect("open");
        let (child, _) = child_in_job(&supervisor, "op-unrelated", 0, "stay");
        let unrelated = start_child(&["sleep", "60000"]);
        unrelated.lines.wait("PID", WAIT);
        supervisor.close("op-unrelated");
        assert!(
            exits_within(child.handle(), CLOSE_BOUND),
            "the owned child ends"
        );
        assert!(
            ends_by_test(unrelated.handle()),
            "the close never began to end the unrelated process"
        );
        supervisor.shutdown();
    }

    #[test]
    fn the_port_is_associated_before_the_first_process_joins() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-port").expect("open");
        let child = start_child(&["sleep", "60000"]);
        supervisor
            .assign("op-port", child.handle())
            .expect("assign");
        let pid = child.child.id();
        let seen = eventually(Duration::from_secs(2), || {
            supervisor.observed_new_processes("op-port").contains(&pid)
        });
        assert!(
            seen,
            "the port reports JOB_OBJECT_MSG_NEW_PROCESS for the first process"
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn the_active_count_after_a_child_exit_counts_a_sleeping_grandchild() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-one").expect("open");
        let (_child, _grandchildren) = child_in_job(&supervisor, "op-one", 1, "exit");
        assert!(
            eventually(Duration::from_secs(2), || supervisor
                .active_processes("op-one")
                == Some(1)),
            "1 active process"
        );
        supervisor.open("op-zero").expect("open");
        let (_child, _) = child_in_job(&supervisor, "op-zero", 0, "exit");
        assert!(
            eventually(Duration::from_secs(2), || supervisor
                .active_processes("op-zero")
                == Some(0)),
            "0 active processes"
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    /// T370: the count leaves out the exited process by its ID. A failed list query gives no count.
    #[test]
    fn the_active_descendants_leave_out_the_exited_process_and_a_failed_query_gives_none() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-ids").expect("open");
        let (child, grandchildren) = child_in_job(&supervisor, "op-ids", 1, "stay");
        let pid = child.child.id();
        let mut listed = supervisor.process_ids("op-ids");
        listed.sort_unstable();
        let mut expected = vec![pid, grandchildren[0].pid];
        expected.sort_unstable();
        assert_eq!(
            listed, expected,
            "the Job holds the child and the grandchild"
        );
        assert_eq!(
            supervisor.active_descendants("op-ids", Some(pid)),
            Some(1),
            "the count leaves out the exited process"
        );
        assert_eq!(supervisor.active_descendants("op-ids", None), Some(2));
        // A handle without JOB_OBJECT_QUERY makes the list query fail.
        let mut assign_only = HANDLE::default();
        // SAFETY: both process handles are the current-process pseudo handle, and the entry keeps the source open.
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                supervisor.job_handle("op-ids").expect("Job handle"),
                GetCurrentProcess(),
                &mut assign_only,
                JOB_OBJECT_ASSIGN_PROCESS,
                false,
                DUPLICATE_HANDLE_OPTIONS(0),
            )
        }
        .expect("DuplicateHandle");
        supervisor
            .shared
            .state()
            .jobs
            .get_mut("op-ids")
            .expect("entry")
            .job = Arc::new(Job {
            handle: assign_only,
        });
        assert_eq!(
            supervisor.active_descendants("op-ids", Some(pid)),
            None,
            "a failed query gives no count"
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn a_lingering_job_closes_at_active_process_zero() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-linger").expect("open");
        let (_child, mut grandchildren) = child_in_job(&supervisor, "op-linger", 1, "exit");
        supervisor.ended("op-linger", false);
        assert!(
            supervisor.is_lingering("op-linger"),
            "the Job lingers while the grandchild sleeps"
        );
        assert!(
            ends_by_test(grandchildren[0].handle),
            "ended never began to end the grandchild"
        );
        grandchildren.clear();
        let closed = eventually(Duration::from_secs(3), || {
            !supervisor.is_lingering("op-linger") && supervisor.job_handle("op-linger").is_none()
        });
        assert!(closed, "the port message closes the empty Job");
        supervisor.shutdown();
    }

    #[test]
    fn a_dropped_zero_message_closes_the_empty_job_at_the_next_ended() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.drop_zero_messages(true);
        supervisor.open("op-missed").expect("open");
        let (_child, mut grandchildren) = child_in_job(&supervisor, "op-missed", 1, "exit");
        supervisor.ended("op-missed", false);
        assert!(supervisor.is_lingering("op-missed"), "the Job lingers");
        grandchildren.clear();
        let job = Arc::clone(&supervisor.shared.state().jobs["op-missed"].job);
        assert!(
            eventually(WAIT, || matches!(job.active_processes(), Ok(0))),
            "the lingering Job is empty"
        );
        supervisor.open("op-next").expect("open");
        let (_next, _) = child_in_job(&supervisor, "op-next", 0, "exit");
        supervisor.ended("op-next", false);
        assert!(
            !supervisor.is_lingering("op-missed"),
            "the ended count check closes the empty Job"
        );
        assert!(
            supervisor.job_handle("op-missed").is_none(),
            "the handle is closed"
        );
        supervisor.shutdown();
    }

    #[test]
    fn closing_the_lingering_set_ends_a_sleeping_grandchild() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-app-close").expect("open");
        let (_child, grandchildren) = child_in_job(&supervisor, "op-app-close", 1, "exit");
        supervisor.ended("op-app-close", false);
        assert!(supervisor.is_lingering("op-app-close"));
        supervisor.close_all();
        assert!(
            grandchildren[0].exits_within(CLOSE_BOUND),
            "application close ends the grandchild within 5 s"
        );
        supervisor.shutdown();
    }

    #[test]
    fn the_port_thread_stops_within_two_seconds_of_shutdown() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-shutdown").expect("open");
        supervisor.close_all();
        let (done, stopped) = mpsc::channel();
        let shared = Arc::clone(&supervisor);
        std::thread::spawn(move || {
            shared.shutdown();
            let _ = done.send(());
        });
        assert!(
            stopped.recv_timeout(Duration::from_secs(2)).is_ok(),
            "the port thread stops within 2 s"
        );
    }

    #[test]
    fn revoke_closes_the_lingering_jobs_of_one_tag() {
        let supervisor = Supervisor::start().expect("start");
        let mut grandchildren = Vec::new();
        for (operation_id, n) in [("op-a1", 1), ("op-a2", 1), ("op-b", 2)] {
            supervisor.open(operation_id).expect("open");
            supervisor.tag(operation_id, tag(n));
            let (_child, mut started) = child_in_job(&supervisor, operation_id, 1, "exit");
            grandchildren.append(&mut started);
            supervisor.ended(operation_id, false);
        }
        assert_eq!(
            supervisor.revoke(&tag(1)),
            2,
            "the active count before the close"
        );
        assert!(
            grandchildren[0].exits_within(CLOSE_BOUND),
            "the first grandchild of the tag ends within 5 s"
        );
        assert!(
            grandchildren[1].exits_within(CLOSE_BOUND),
            "the second grandchild of the tag ends within 5 s"
        );
        assert!(supervisor.is_lingering("op-b"));
        assert_eq!(supervisor.lingering_count(&tag(2)), 1);
        assert!(
            ends_by_test(grandchildren[2].handle),
            "revoke never began to end the Job with another tag"
        );
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn the_lingering_count_of_a_tag_sums_its_jobs() {
        let supervisor = Supervisor::start().expect("start");
        let mut keep = Vec::new();
        for (operation_id, count) in [("op-sum1", 2), ("op-sum2", 1)] {
            supervisor.open(operation_id).expect("open");
            supervisor.tag(operation_id, tag(7));
            keep.push(child_in_job(&supervisor, operation_id, count, "exit"));
            supervisor.ended(operation_id, false);
        }
        assert_eq!(supervisor.lingering_count(&tag(7)), 3);
        assert_eq!(supervisor.lingering_count(&tag(8)), 0, "another tag");
        supervisor.close_all();
        supervisor.shutdown();
    }

    #[test]
    fn ended_with_end_processes_closes_the_job_at_once() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-end").expect("open");
        supervisor.tag("op-end", tag(3));
        let (_child, grandchildren) = child_in_job(&supervisor, "op-end", 1, "exit");
        supervisor.ended("op-end", true);
        assert!(!supervisor.is_lingering("op-end"), "the Job never lingers");
        assert!(
            supervisor.job_handle("op-end").is_none(),
            "the handle is closed"
        );
        assert!(
            grandchildren[0].exits_within(CLOSE_BOUND),
            "the grandchild ends within 5 s"
        );
        assert_eq!(supervisor.lingering_count(&tag(3)), 0);
        supervisor.shutdown();
    }

    #[test]
    fn a_tagged_lingering_job_keeps_its_tag_across_a_service_restart() {
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-kept").expect("open");
        supervisor.tag("op-kept", tag(5));
        let (_child, grandchildren) = child_in_job(&supervisor, "op-kept", 1, "exit");
        supervisor.ended("op-kept", false);
        supervisor.open("op-running").expect("open");
        let (running, _) = child_in_job(&supervisor, "op-running", 0, "stay");
        supervisor.service_exited();
        assert!(
            exits_within(running.handle(), CLOSE_BOUND),
            "the operation Job outside the lingering set closes"
        );
        assert!(
            supervisor.is_lingering("op-kept"),
            "the lingering Job stays"
        );
        assert_eq!(supervisor.lingering_count(&tag(5)), 1, "the tag stays");
        assert_eq!(supervisor.revoke(&tag(5)), 1);
        assert!(grandchildren[0].exits_within(CLOSE_BOUND));
        supervisor.shutdown();
    }

    #[test]
    fn a_grandchild_that_writes_to_inherited_pipes_after_the_child_exit_stays_in_the_job() {
        let fixture = Fixture::new();
        let result = fixture.path("late-writer.txt");
        let supervisor = Supervisor::start().expect("start");
        supervisor.open("op-pipes").expect("open");
        let exit_file = fixture.path("exit.txt");
        let mut child = start_child(&[
            "pipe-holder",
            "500",
            "1048576",
            result.to_str().expect("path"),
            exit_file.to_str().expect("path"),
        ]);
        supervisor
            .assign("op-pipes", child.handle())
            .expect("assign");
        child.go();
        let grandchild = Proc::open(child.lines.wait("GRANDCHILD", WAIT).parse().expect("pid"));
        assert!(exits_within(child.handle(), WAIT), "the child exits");
        assert!(
            wait_file(&result, "ok", WAIT).is_some(),
            "the grandchild writes after the child exit"
        );
        assert_eq!(supervisor.active_processes("op-pipes"), Some(1));
        let mut in_job = BOOL(0);
        unsafe {
            IsProcessInJob(
                grandchild.handle,
                supervisor.job_handle("op-pipes"),
                &mut in_job,
            )
        }
        .expect("IsProcessInJob");
        assert!(in_job.as_bool(), "the grandchild stays in the Job");
        supervisor.close("op-pipes");
        assert!(
            grandchild.exits_within(CLOSE_BOUND),
            "the close ends the grandchild"
        );
        supervisor.shutdown();
    }

    // ---- T225, T228: activity (contract §6 "Activity and stall notice", §12 "Deadlines and Cancel") ----

    pub(crate) type Events = Arc<Mutex<Vec<(Instant, Event)>>>;

    /// A sink that records each event with its time.
    pub(crate) fn recorder() -> (Events, impl Fn(Event) + Send + Sync + 'static) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&events);
        (events, move |event| {
            shared.lock().expect("events").push((Instant::now(), event));
        })
    }

    pub(crate) fn kinds(events: &Events) -> Vec<Event> {
        events
            .lock()
            .expect("events")
            .iter()
            .map(|(_, e)| *e)
            .collect()
    }

    const STALL: Duration = Duration::from_secs(15);

    #[test]
    fn a_changed_sum_or_an_output_byte_is_activity_and_each_state_change_sends_one_event() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut a = Activity::new(t0, STALL, Some(Duration::from_secs(300)));
        assert_eq!(
            a.sample(at(1), Some(100)),
            None,
            "the first sum is the base"
        );
        assert_eq!(a.sample(at(14), Some(100)), None);
        assert_eq!(
            a.sample(at(15), Some(100)),
            Some(Event::Stalled),
            "15 s without activity"
        );
        assert_eq!(a.sample(at(16), Some(100)), None, "stalled goes out once");
        assert_eq!(
            a.sample(at(17), Some(101)),
            Some(Event::Active),
            "a changed sum"
        );
        assert_eq!(a.sample(at(31), Some(101)), None);
        assert_eq!(a.sample(at(32), Some(101)), Some(Event::Stalled));
        assert_eq!(a.output(at(33)), Some(Event::Active), "an output byte");
        assert_eq!(a.output(at(34)), None, "active goes out once");
        assert_eq!(
            a.sample(at(40), Some(7)),
            None,
            "a lower sum is activity too"
        );
        assert_eq!(a.sample(at(54), Some(7)), None);
        assert_eq!(a.sample(at(55), Some(7)), Some(Event::Stalled));
    }

    #[test]
    fn an_unknown_sample_is_no_idle_time_and_the_next_known_sample_is_the_new_base() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut a = Activity::new(t0, STALL, Some(Duration::from_secs(300)));
        assert_eq!(a.sample(at(1), Some(5)), None);
        for s in 2..=400 {
            assert_eq!(a.sample(at(s), None), None, "unknown at {s} s");
        }
        assert!(!a.expired, "no inactivity limit while samples stay unknown");
        assert_eq!(a.sample(at(401), Some(5)), None, "the new base");
        assert_eq!(a.sample(at(415), Some(5)), None);
        assert_eq!(
            a.sample(at(416), Some(5)),
            Some(Event::Stalled),
            "15 s after the known base"
        );
        assert_eq!(
            a.sample(at(417), None),
            None,
            "an unknown sample sends no event"
        );
        assert_eq!(
            a.sample(at(418), Some(9)),
            None,
            "a known sample after an unknown one is a base, not activity"
        );
        assert_eq!(a.sample(at(419), Some(10)), Some(Event::Active));
        for s in 420..=800 {
            assert_eq!(a.sample(at(s), Some(s)), None, "a changing sum at {s} s");
        }
        assert_eq!(a.sample(at(1100), Some(800)), Some(Event::Inactivity));
    }

    #[test]
    fn an_unchanged_sum_without_output_ends_at_the_inactivity_limit_and_a_commit_has_none() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut a = Activity::new(t0, STALL, Some(Duration::from_secs(300)));
        assert_eq!(a.sample(at(1), Some(5)), None);
        assert_eq!(a.sample(at(15), Some(5)), Some(Event::Stalled));
        assert_eq!(a.sample(at(299), Some(5)), None);
        assert_eq!(a.sample(at(300), Some(5)), Some(Event::Inactivity));
        assert_eq!(
            a.sample(at(301), Some(6)),
            None,
            "no event follows the expiry"
        );
        assert_eq!(a.output(at(302)), None);
        let mut commit = Activity::new(t0, STALL, None);
        assert_eq!(commit.sample(at(15), Some(5)), Some(Event::Stalled));
        assert_eq!(commit.sample(at(100_000), Some(5)), None);
    }

    #[test]
    fn the_io_sum_of_a_job_grows_with_file_io_and_an_idle_child_keeps_it() {
        let fixture = Fixture::new();
        let job = Job::create().expect("Job");
        let file = fixture.path("io");
        let idle = start_child(&["sleep", "10000"]);
        job.assign(idle.handle()).expect("assign");
        idle.lines.wait("PID", WAIT);
        std::thread::sleep(Duration::from_millis(500));
        let before = job.io_sum().expect("sum");
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(
            job.io_sum(),
            Some(before),
            "an idle child changes no counter"
        );
        let mut writer = start_child(&["io", &file.to_string_lossy(), "0", "50", "20"]);
        job.assign(writer.handle()).expect("assign");
        let _ = writer.child.wait();
        let after = job.io_sum().expect("sum");
        // Twenty 4 KiB writes add at least their transfer bytes to `WriteTransferCount`.
        assert!(after >= before + 20 * 4096, "{before} -> {after}");
    }

    #[test]
    fn the_port_thread_sends_stalled_for_an_idle_job_and_active_when_its_io_resumes() {
        let fixture = Fixture::new();
        let supervisor = Supervisor::start().expect("supervisor");
        supervisor.open("op-activity").expect("open");
        let file = fixture.path("io");
        let mut child = start_child(&["io", &file.to_string_lossy(), "4500", "100", "20"]);
        supervisor
            .assign("op-activity", child.handle())
            .expect("assign");
        child.lines.wait("PID", WAIT);
        let (events, sink) = recorder();
        let start = Instant::now();
        let tracker = Tracker::new(Duration::from_millis(1500), None, sink);
        assert!(supervisor.track("op-activity", &tracker));
        assert!(
            eventually(Duration::from_secs(10), || kinds(&events).len() >= 2),
            "{:?}",
            kinds(&events)
        );
        let recorded = events.lock().expect("events").clone();
        assert_eq!(kinds(&events), [Event::Stalled, Event::Active]);
        let stalled = recorded[0].0 - start;
        // The port thread reads the sum once per second.
        assert!(
            stalled >= Duration::from_millis(1500) && stalled < Duration::from_millis(3000),
            "{stalled:?}"
        );
        assert!(recorded[1].0 - start >= Duration::from_millis(4500));
        supervisor.untrack("op-activity", &tracker);
        let _ = child.child.wait();
        // Only the port thread clones a tracked `Arc`. So no sample can reach the sink when the test holds the last one.
        assert!(
            eventually(WAIT, || Arc::strong_count(&tracker) == 1),
            "no sample holds the tracker"
        );
        assert_eq!(kinds(&events).len(), 2, "no event after untrack");
        assert!(!tracker.expired());
        supervisor.shutdown();
    }

    #[test]
    fn an_idle_job_reaches_the_inactivity_limit_once() {
        let supervisor = Supervisor::start().expect("supervisor");
        supervisor.open("op-idle").expect("open");
        let child = start_child(&["sleep", "20000"]);
        supervisor
            .assign("op-idle", child.handle())
            .expect("assign");
        child.lines.wait("PID", WAIT);
        let (events, sink) = recorder();
        let start = Instant::now();
        let tracker = Tracker::new(STALL, Some(Duration::from_millis(1500)), sink);
        assert!(supervisor.track("op-idle", &tracker));
        assert!(eventually(Duration::from_secs(10), || !kinds(&events).is_empty()));
        let elapsed = events.lock().expect("events")[0].0 - start;
        assert!(
            elapsed >= Duration::from_millis(1500) && elapsed < Duration::from_millis(3000),
            "{elapsed:?}"
        );
        // One more sample pass of the port thread code, after the expiry.
        supervisor.shared.sample();
        assert_eq!(kinds(&events), [Event::Inactivity]);
        assert!(tracker.expired());
        supervisor.close("op-idle");
        assert!(exits_within(child.handle(), CLOSE_BOUND));
        assert!(
            !supervisor.track("op-idle", &tracker),
            "a closed Job tracks nothing"
        );
        supervisor.shutdown();
    }
}
