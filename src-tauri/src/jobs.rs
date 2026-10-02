// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shell does not use these items yet. T037 removes this attribute.
#![allow(dead_code)]

use std::sync::Arc;

use windows::Win32::Foundation::HANDLE;

use crate::bootstrap::Identity;

/// One Job object. It has kill-on-close and no breakaway, and its handle is not inheritable (contract §6).
pub struct Job {
    handle: HANDLE,
}

impl Job {
    pub fn create() -> windows::core::Result<Job> {
        todo!("T031")
    }

    pub fn handle(&self) -> HANDLE {
        self.handle
    }

    pub fn assign(&self, _process: HANDLE) -> windows::core::Result<()> {
        todo!("T031")
    }

    pub fn active_processes(&self) -> windows::core::Result<u32> {
        todo!("T031")
    }
}

/// Owns the operation Jobs, the lingering set, and the completion-port thread (contract §6 "Lingering Jobs").
pub struct Supervisor {
    _private: (),
}

impl Supervisor {
    /// Creates the completion port and starts its reader thread.
    pub fn start() -> windows::core::Result<Arc<Supervisor>> {
        todo!("T031")
    }

    /// Creates the Job of an operation and associates the port before any process joins.
    pub fn open(&self, _operation_id: &str) -> windows::core::Result<()> {
        todo!("T031")
    }

    /// Sets the common-directory identity tag of a mutation Job.
    pub fn tag(&self, _operation_id: &str, _tag: Identity) {
        todo!("T031")
    }

    pub fn assign(&self, _operation_id: &str, _process: HANDLE) -> windows::core::Result<()> {
        todo!("T031")
    }

    /// The open Job handle of an operation, or of a lingering Job.
    pub fn job_handle(&self, _operation_id: &str) -> Option<HANDLE> {
        todo!("T031")
    }

    /// The active process count from `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`.
    pub fn active_processes(&self, _operation_id: &str) -> Option<u32> {
        todo!("T031")
    }

    /// The IDs of the processes in the Job. Only tests read process IDs.
    pub fn process_ids(&self, _operation_id: &str) -> Vec<u32> {
        todo!("T031")
    }

    /// Closes the Job at once, with every descendant. Cancel, deadline, and `closeJob` use it.
    pub fn close(&self, _operation_id: &str) {
        todo!("T031")
    }

    /// Handles an `ended` frame (contract §6 "Lingering Jobs").
    pub fn ended(&self, _operation_id: &str, _end_processes: bool) {
        todo!("T031")
    }

    pub fn is_lingering(&self, _operation_id: &str) -> bool {
        todo!("T031")
    }

    /// The sum of the active process counts of the lingering Jobs with this tag.
    pub fn lingering_count(&self, _tag: &Identity) -> u32 {
        todo!("T031")
    }

    /// Closes the lingering Jobs with this tag. Returns their active process count before the close.
    pub fn revoke(&self, _tag: &Identity) -> u32 {
        todo!("T031")
    }

    /// Closes every operation Job outside the lingering set.
    pub fn service_exited(&self) {
        todo!("T031")
    }

    /// Application close: closes the operation Jobs, then the lingering Jobs.
    pub fn close_all(&self) {
        todo!("T031")
    }

    /// Stops the port thread.
    pub fn shutdown(&self) {
        todo!("T031")
    }

    /// Test hook: the process IDs of the `JOB_OBJECT_MSG_NEW_PROCESS` messages of a Job.
    pub fn observed_new_processes(&self, _operation_id: &str) -> Vec<u32> {
        todo!("T031")
    }

    /// Test hook: drops every `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` message while set.
    pub fn drop_zero_messages(&self, _drop: bool) {
        todo!("T031")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

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
        CloseHandle, GENERIC_READ, GENERIC_WRITE, GetHandleInformation, HANDLE_FLAG_INHERIT,
        WAIT_OBJECT_0,
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
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
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

    /// An owned fixture folder in the temporary directory. Drop removes it.
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
            let _ = std::fs::remove_dir_all(&self.0);
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
        let mut command = Command::new(test_exe());
        command.args(child_arguments(mode)).stdin(Stdio::null());
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

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
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
            // version: the output of a Git version probe.
            "version" => {
                print_line("git version 2.55.0.windows.3");
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

    fn tag(n: u8) -> Identity {
        Identity {
            volume_serial: 0x4474_2150_7421_4650,
            file_id: [n; 16],
        }
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
            !exits_within(second.handle(), Duration::from_secs(1)),
            "the second child keeps running"
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
            !exits_within(unrelated.handle(), Duration::from_secs(1)),
            "the unrelated process survives"
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
            !grandchildren[0].exits_within(Duration::from_secs(1)),
            "the grandchild keeps running"
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
        std::thread::sleep(Duration::from_millis(1500));
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
        assert!(
            !grandchildren[2].exits_within(Duration::from_secs(1)),
            "the Job with another tag keeps running"
        );
        assert!(supervisor.is_lingering("op-b"));
        assert_eq!(supervisor.lingering_count(&tag(2)), 1);
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
}
