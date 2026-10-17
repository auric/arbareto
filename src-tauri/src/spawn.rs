// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::path::Path;

use windows::Wdk::System::SystemServices::RtlUpcaseUnicodeChar;
use windows::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DETACHED_PROCESS, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_CREATION_FLAGS,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute,
};
use windows::core::{PCWSTR, PWSTR};

const QUOTE: u16 = b'"' as u16;
const BACKSLASH: u16 = b'\\' as u16;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const EQUALS: u16 = b'=' as u16;

/// The `CreateProcessW` command-line limit in UTF-16 units, with the terminating null (contract §6 "Process fields").
pub const COMMAND_LINE_UNITS: usize = 32_767;

#[derive(Debug, PartialEq, Eq)]
pub enum SpawnError {
    /// The quoted command line exceeds `COMMAND_LINE_UNITS`. No process starts.
    CommandLineTooLong,
    /// An argument holds NUL. No process starts.
    InvalidArgument,
    /// The start in the Job or the resume failed, and no owned process runs. The reply code is `PROCESS_OWNERSHIP_FAILED`.
    OwnershipFailed,
}

/// The stdin of the child (contract §6 "Console and input").
#[derive(Clone, Copy)]
pub enum Input<'a> {
    /// The parent end closes at once.
    Closed,
    /// The shell writes these bytes, then closes the parent end.
    Bytes(&'a [u8]),
    /// The parent end stays open for streamed input. `Spawned::stdin` holds it.
    Stream,
}

pub struct SpawnRequest<'a> {
    pub program: &'a Path,
    pub arguments: &'a [String],
    pub environment: &'a [(OsString, OsString)],
    pub current_dir: &'a Path,
    /// Only a `wsl.exe` request sets it (contract §6 "Console and input").
    pub wsl: bool,
    pub input: Input<'a>,
}

pub struct Spawned {
    /// The caller owns and closes this handle.
    pub process: HANDLE,
    pub pid: u32,
    pub stdin: Option<File>,
    pub stdout: File,
    pub stderr: File,
}

/// Quotes the program and the arguments into a null-terminated `CreateProcessW` command line.
/// The rules equal Rust std `make_command_line` and `append_arg` (library/std/src/sys/process/windows.rs, sys/pal/windows/args.rs).
pub fn command_line(program: &Path, arguments: &[String]) -> Result<Vec<u16>, SpawnError> {
    let mut line = vec![QUOTE];
    for unit in program.as_os_str().encode_wide() {
        if unit == 0 || unit == QUOTE {
            return Err(SpawnError::InvalidArgument);
        }
        line.push(unit);
    }
    line.push(QUOTE);
    for argument in arguments {
        line.push(SPACE);
        let units: Vec<u16> = argument.encode_utf16().collect();
        if units.contains(&0) {
            return Err(SpawnError::InvalidArgument);
        }
        let quote = units.is_empty() || units.contains(&SPACE) || units.contains(&TAB);
        if quote {
            line.push(QUOTE);
        }
        let mut backslashes = 0;
        for unit in units {
            if unit == BACKSLASH {
                backslashes += 1;
            } else {
                if unit == QUOTE {
                    line.extend(std::iter::repeat_n(BACKSLASH, backslashes + 1));
                }
                backslashes = 0;
            }
            line.push(unit);
        }
        if quote {
            line.extend(std::iter::repeat_n(BACKSLASH, backslashes));
            line.push(QUOTE);
        }
    }
    line.push(0);
    if line.len() > COMMAND_LINE_UNITS {
        return Err(SpawnError::CommandLineTooLong);
    }
    Ok(line)
}

pub fn creation_flags(wsl: bool) -> PROCESS_CREATION_FLAGS {
    let console = if wsl {
        CREATE_NO_WINDOW
    } else {
        DETACHED_PROCESS
    };
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | console
}

pub(crate) fn null_terminated(value: &OsStr) -> Result<Vec<u16>, SpawnError> {
    let units: Vec<u16> = value.encode_wide().chain(Some(0)).collect();
    if units[..units.len() - 1].contains(&0) {
        return Err(SpawnError::InvalidArgument);
    }
    Ok(units)
}

/// The block is sorted by name without case, in Unicode order (Microsoft Learn "Changing Environment Variables").
pub(crate) fn environment_block(
    environment: &[(OsString, OsString)],
) -> Result<Vec<u16>, SpawnError> {
    let mut entries = Vec::with_capacity(environment.len());
    for (name, value) in environment {
        let name: Vec<u16> = name.encode_wide().collect();
        let value: Vec<u16> = value.encode_wide().collect();
        if name.is_empty() || name[1..].contains(&EQUALS) || name.contains(&0) || value.contains(&0)
        {
            return Err(SpawnError::InvalidArgument);
        }
        entries.push((name, value));
    }
    entries.sort_by_cached_key(|(name, _)| {
        name.iter()
            // SAFETY: the call takes and returns one UTF-16 unit by value.
            .map(|&unit| unsafe { RtlUpcaseUnicodeChar(unit) })
            .collect::<Vec<u16>>()
    });
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name);
        block.push(EQUALS);
        block.extend(value);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// A pipe with two non-inheritable ends: the parent end and the child end.
fn pipe() -> Result<(OwnedHandle, OwnedHandle), SpawnError> {
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    // SAFETY: no security attributes, so neither end is inheritable. The caller owns both ends.
    unsafe { CreatePipe(&mut read, &mut write, None, 0) }
        .map_err(|_| SpawnError::OwnershipFailed)?;
    // SAFETY: CreatePipe returned two new handles that nothing else owns.
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read.0),
            OwnedHandle::from_raw_handle(write.0),
        )
    })
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

/// A child that `create_suspended` started. Its Job holds it, and it runs no code before `resume`.
/// A drop without `resume` closes the handles. The child then ends when its Job closes.
pub struct Suspended<'a> {
    process: OwnedHandle,
    thread: OwnedHandle,
    pub(crate) pid: u32,
    input: Input<'a>,
    stdin: File,
    stdout: File,
    stderr: File,
}

/// Starts the child suspended in `job`, then resumes it.
pub fn spawn(request: &SpawnRequest, job: HANDLE) -> Result<Spawned, SpawnError> {
    create_suspended(request, job)?.resume()
}

/// Creates the child suspended and already in `job` (Microsoft Learn `UpdateProcThreadAttribute` `PROC_THREAD_ATTRIBUTE_JOB_LIST`).
/// The caller keeps `job` open for the call.
pub fn create_suspended<'a>(
    request: &SpawnRequest<'a>,
    job: HANDLE,
) -> Result<Suspended<'a>, SpawnError> {
    let mut command_line = command_line(request.program, request.arguments)?;
    let application = null_terminated(request.program.as_os_str())?;
    let directory = null_terminated(request.current_dir.as_os_str())?;
    let environment = environment_block(request.environment)?;

    let (child_stdin, parent_stdin) = pipe()?;
    let (parent_stdout, child_stdout) = pipe()?;
    let (parent_stderr, child_stderr) = pipe()?;
    let inherited = [raw(&child_stdin), raw(&child_stdout), raw(&child_stderr)];
    for handle in inherited {
        // SAFETY: the handle is open. Only the handle list below passes it to the child.
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
            .map_err(|_| SpawnError::OwnershipFailed)?;
    }

    let jobs = [job];
    let mut size = 0;
    // SAFETY: a size query without a list. It fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
    let _ = unsafe { InitializeProcThreadAttributeList(None, 2, None, &mut size) };
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
    // SAFETY: `storage` is pointer-aligned and holds at least `size` bytes.
    unsafe { InitializeProcThreadAttributeList(Some(list), 2, None, &mut size) }
        .map_err(|_| SpawnError::OwnershipFailed)?;
    // SAFETY: `inherited` and `jobs` outlive the list use in CreateProcessW below. Each size is that of its array.
    let updated = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(inherited.as_ptr().cast()),
            size_of_val(&inherited),
            None,
            None,
        )
        .and_then(|()| {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(jobs.as_ptr().cast()),
                size_of_val(&jobs),
                None,
                None,
            )
        })
    };
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = list;
    let mut info = PROCESS_INFORMATION::default();
    let created = updated.and_then(|()| {
        // SAFETY: every string is null-terminated and outlives the call. `command_line` is writable.
        // The environment block ends with two nulls and matches CREATE_UNICODE_ENVIRONMENT.
        unsafe {
            CreateProcessW(
                PCWSTR(application.as_ptr()),
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                true,
                creation_flags(request.wsl),
                Some(environment.as_ptr().cast()),
                PCWSTR(directory.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        }
    });
    // SAFETY: the list was initialized above, and CreateProcessW has returned.
    unsafe { DeleteProcThreadAttributeList(list) };
    drop((child_stdin, child_stdout, child_stderr));
    created.map_err(|_| SpawnError::OwnershipFailed)?;

    // SAFETY: CreateProcessW returned both handles, and this function owns them.
    let (process, thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(info.hProcess.0),
            OwnedHandle::from_raw_handle(info.hThread.0),
        )
    };
    Ok(Suspended {
        process,
        thread,
        pid: info.dwProcessId,
        input: request.input,
        stdin: File::from(parent_stdin),
        stdout: File::from(parent_stdout),
        stderr: File::from(parent_stderr),
    })
}

impl Suspended<'_> {
    /// A failed resume terminates the child.
    pub fn resume(self) -> Result<Spawned, SpawnError> {
        // SAFETY: `thread` is the open primary thread handle of the suspended child.
        if unsafe { ResumeThread(raw(&self.thread)) } == u32::MAX {
            // SAFETY: `process` is open. Its drop closes it.
            let _ = unsafe { TerminateProcess(raw(&self.process), 1) };
            return Err(SpawnError::OwnershipFailed);
        }
        let mut parent_stdin = self.stdin;
        let stdin = match self.input {
            Input::Closed => {
                drop(parent_stdin);
                None
            }
            Input::Bytes(bytes) => {
                // A child that reads late must not block the caller. The write ends when the child reads or exits.
                let bytes = bytes.to_vec();
                std::thread::spawn(move || {
                    let _ = parent_stdin.write_all(&bytes);
                });
                None
            }
            Input::Stream => Some(parent_stdin),
        };
        Ok(Spawned {
            process: HANDLE(self.process.into_raw_handle()),
            pid: self.pid,
            stdin,
            stdout: self.stdout,
            stderr: self.stderr,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::time::Duration;

    use windows::Win32::Foundation::{
        DUPLICATE_HANDLE_OPTIONS, DuplicateHandle, HANDLE_FLAG_INHERIT, SetHandleInformation,
    };
    use windows::Win32::System::JobObjects::IsProcessInJob;
    use windows::Win32::System::SystemServices::JOB_OBJECT_QUERY;
    use windows::Win32::System::Threading::{
        CREATE_NEW_CONSOLE, CREATE_NO_WINDOW, CREATE_SUSPENDED, DETACHED_PROCESS,
        GetCurrentProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::core::BOOL;

    use crate::jobs::Job;
    use crate::jobs::tests::{
        CLOSE_BOUND, Fixture, Lines, Proc, WAIT, child_arguments, eventually, final_path,
        same_path, start_child, test_exe,
    };

    struct Run {
        pid: u32,
        stdout: Lines,
        _stderr: Lines,
        _process: Proc,
    }

    fn environment() -> Vec<(OsString, OsString)> {
        std::env::vars_os().collect()
    }

    fn request<'a>(
        program: &'a Path,
        arguments: &'a [String],
        environment: &'a [(OsString, OsString)],
        wsl: bool,
        input: Input<'a>,
    ) -> SpawnRequest<'a> {
        static DIRECTORY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        let current_dir = DIRECTORY.get_or_init(std::env::temp_dir);
        SpawnRequest {
            program,
            arguments,
            environment,
            current_dir,
            wsl,
            input,
        }
    }

    /// Starts the test binary in a new Job with the child mode `mode`.
    fn run(job: &Job, mode: &[&str], wsl: bool, input: Input) -> Run {
        let program = test_exe();
        let arguments = child_arguments(mode);
        let environment = environment();
        let spawned = spawn(
            &request(&program, &arguments, &environment, wsl, input),
            job.handle(),
        )
        .expect("spawn");
        Run {
            pid: spawned.pid,
            stdout: Lines::new(spawned.stdout),
            _stderr: Lines::new(spawned.stderr),
            _process: Proc {
                handle: spawned.process,
                pid: spawned.pid,
            },
        }
    }

    fn report(job: &Job, mode: &[&str], wsl: bool, input: Input) -> (u32, serde_json::Value) {
        let run = run(job, mode, wsl, input);
        let text = run.stdout.wait("REPORT", WAIT);
        (run.pid, serde_json::from_str(&text).expect("report JSON"))
    }

    const TRICKY: [&str; 16] = [
        "plain",
        "with space",
        "tab\there",
        "\"quoted\"",
        "inner \"quote\" here",
        r"trailing\",
        r"trailing\\",
        r"C:\dir with space\",
        r#"a\\\"b"#,
        "Ünïcödé ✓ 日本語 😀",
        "--exact",
        "--help",
        "-q",
        "--",
        "-",
        "",
    ];

    #[test]
    fn arguments_reach_the_child_unchanged() {
        let job = Job::create().expect("Job");
        let mut mode = vec!["report"];
        mode.extend(TRICKY);
        let (_, report) = report(&job, &mode, false, Input::Closed);
        let expected: Vec<serde_json::Value> =
            TRICKY.iter().map(|s| serde_json::Value::from(*s)).collect();
        assert_eq!(report["args"].as_array().expect("args"), &expected);
    }

    #[test]
    fn the_application_name_is_the_program_and_no_shell_starts() {
        let job = Job::create().expect("Job");
        let (pid, report) = report(&job, &["report"], false, Input::Closed);
        assert_eq!(
            report["pid"], pid,
            "the spawned process is the program itself, with no intermediate shell"
        );
        let exe = report["exe"].as_str().expect("exe");
        assert!(
            same_path(exe, test_exe().to_str().expect("path")),
            "lpApplicationName names the program: {exe}"
        );
    }

    #[test]
    fn a_command_line_above_the_limit_is_refused_before_process_creation() {
        let program = Path::new(r"C:\arbareto-absent\absent program.exe");
        let base = command_line(program, &["a".to_string()])
            .expect("short command line")
            .len();
        let fill = COMMAND_LINE_UNITS - base + 1;
        assert_eq!(
            command_line(program, &["a".repeat(fill)])
                .expect("at the limit")
                .len(),
            COMMAND_LINE_UNITS
        );
        assert_eq!(
            command_line(program, &["a".repeat(fill + 1)]),
            Err(SpawnError::CommandLineTooLong)
        );
        // One U+1F600 is two UTF-16 units, one `char`, and four UTF-8 bytes.
        let units_at_limit = format!("😀{}", "a".repeat(fill - 2));
        assert_eq!(
            command_line(program, &[units_at_limit])
                .expect("UTF-16 units at the limit")
                .len(),
            COMMAND_LINE_UNITS
        );
        let units_above = vec![format!("{}😀", "a".repeat(fill - 1))];
        assert_eq!(
            command_line(program, &units_above),
            Err(SpawnError::CommandLineTooLong)
        );
        let environment = environment();
        let job = Job::create().expect("Job");
        let result = spawn(
            &request(program, &units_above, &environment, false, Input::Closed),
            job.handle(),
        );
        // An attempted start of the absent program would give `OwnershipFailed` instead.
        assert!(
            matches!(result, Err(SpawnError::CommandLineTooLong)),
            "refused before process creation"
        );
        assert_eq!(
            job.total_processes(),
            Ok(0),
            "no process ever joined the Job"
        );
    }

    #[test]
    fn only_the_intended_pipe_handles_are_inherited() {
        let fixture = Fixture::new();
        let marker = File::create(fixture.path("marker.txt")).expect("marker file");
        let handle = HANDLE(marker.as_raw_handle());
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
            .expect("make the marker inheritable");
        let path = final_path(handle).expect("marker path");
        let job = Job::create().expect("Job");
        let run = run(
            &job,
            &["marker", &(handle.0 as usize).to_string(), &path],
            false,
            Input::Closed,
        );
        let report: serde_json::Value =
            serde_json::from_str(&run.stdout.wait("MARKER", WAIT)).expect("marker JSON");
        assert_eq!(
            report["inherited"], false,
            "the marker handle stays in the parent"
        );
    }

    #[test]
    fn the_child_starts_suspended_in_its_job_and_then_resumes() {
        let fixture = Fixture::new();
        let started = fixture.path("started.txt");
        let job = Job::create().expect("Job");
        let program = test_exe();
        let arguments = child_arguments(&["started", started.to_str().expect("path")]);
        let environment = environment();
        let suspended = create_suspended(
            &request(&program, &arguments, &environment, false, Input::Closed),
            job.handle(),
        )
        .expect("create");
        // A failed assertion must not leave the suspended child outside every Job.
        let _child = Proc::open(suspended.pid);
        let mut member = BOOL(0);
        // SAFETY: `suspended` keeps the process handle open, and `job` keeps the Job handle open.
        unsafe { IsProcessInJob(raw(&suspended.process), Some(job.handle()), &mut member) }
            .expect("IsProcessInJob");
        assert!(
            member.as_bool(),
            "the Job holds the child from its creation, before the resume"
        );
        std::thread::sleep(Duration::from_secs(1));
        assert!(
            !started.exists(),
            "the child runs no code before the resume"
        );
        let spawned = suspended.resume().expect("resume");
        let _process = Proc {
            handle: spawned.process,
            pid: spawned.pid,
        };
        let _stderr = Lines::new(spawned.stderr);
        let report: serde_json::Value =
            serde_json::from_str(&Lines::new(spawned.stdout).wait("STARTED", WAIT)).expect("JSON");
        assert_eq!(
            report["jobPids"],
            serde_json::json!([spawned.pid]),
            "after the resume, its immediate Job holds only the child"
        );
    }

    #[test]
    fn an_injected_job_assignment_failure_starts_no_process() {
        let program = test_exe();
        let arguments = child_arguments(&["sleep", "60000"]);
        let environment = environment();
        let job = Job::create().expect("Job");
        // A handle without JOB_OBJECT_ASSIGN_PROCESS makes the start in the Job fail.
        let mut query_only = HANDLE::default();
        // SAFETY: both process handles are the current-process pseudo handle, and `job` keeps the source open.
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                job.handle(),
                GetCurrentProcess(),
                &mut query_only,
                JOB_OBJECT_QUERY,
                false,
                DUPLICATE_HANDLE_OPTIONS(0),
            )
        }
        .expect("DuplicateHandle");
        // SAFETY: DuplicateHandle returned a new handle that nothing else owns.
        let query_only = unsafe { OwnedHandle::from_raw_handle(query_only.0) };
        let result = spawn(
            &request(&program, &arguments, &environment, false, Input::Closed),
            raw(&query_only),
        );
        assert!(
            matches!(result, Err(SpawnError::OwnershipFailed)),
            "PROCESS_OWNERSHIP_FAILED"
        );
        assert_eq!(
            job.total_processes(),
            Ok(0),
            "no process ever joined the Job"
        );
    }

    #[test]
    fn a_child_whose_parent_dies_before_the_resume_ends_within_5_seconds() {
        let helper = start_child(&["suspended"]);
        let grandchild = Proc::open(helper.lines.wait("GRANDCHILD", WAIT).parse().expect("pid"));
        drop(helper);
        assert!(
            grandchild.exits_within(CLOSE_BOUND),
            "the suspended child ends with the Job of its dead parent"
        );
    }

    #[test]
    fn every_request_except_wsl_gets_detached_process() {
        let windows = creation_flags(false);
        assert!(windows.contains(DETACHED_PROCESS), "DETACHED_PROCESS");
        assert!(windows.contains(CREATE_SUSPENDED), "CREATE_SUSPENDED");
        assert!(!windows.contains(CREATE_NO_WINDOW), "no CREATE_NO_WINDOW");
        assert!(
            !windows.contains(CREATE_NEW_CONSOLE),
            "no CREATE_NEW_CONSOLE"
        );
        let wsl = creation_flags(true);
        assert!(
            wsl.contains(CREATE_NO_WINDOW),
            "wsl.exe gets CREATE_NO_WINDOW"
        );
        assert!(wsl.contains(CREATE_SUSPENDED), "CREATE_SUSPENDED");
        assert!(
            !wsl.contains(DETACHED_PROCESS),
            "wsl.exe gets no DETACHED_PROCESS"
        );
        assert!(!wsl.contains(CREATE_NEW_CONSOLE), "no CREATE_NEW_CONSOLE");
    }

    #[test]
    fn a_detached_child_has_no_console() {
        let job = Job::create().expect("Job");
        let (_, report) = report(&job, &["report"], false, Input::Closed);
        assert_eq!(report["conout"], false, "CreateFileW(\"CONOUT$\") fails");
        assert_eq!(
            report["consoleWindowNull"], true,
            "GetConsoleWindow returns null"
        );
    }

    #[test]
    fn a_wsl_request_child_gets_a_hidden_console() {
        let job = Job::create().expect("Job");
        let (_, report) = report(&job, &["report"], true, Input::Closed);
        // A probe on 2026-10-03 saw CONOUT$ open under CREATE_NO_WINDOW and fail under DETACHED_PROCESS.
        assert_eq!(report["conout"], true, "CREATE_NO_WINDOW gives a console");
    }

    // ---- Git for Windows wrapper (contract §6 "Console and input", research R14 S17) ----

    /// The Git for Windows wrapper `cmd\git.exe`, found at test time.
    fn find_wrapper() -> Option<PathBuf> {
        let found = std::env::var_os("ProgramFiles")
            .map(|folder| PathBuf::from(folder).join(r"Git\cmd\git.exe"))
            .into_iter()
            .chain([PathBuf::from(r"C:\Git\cmd\git.exe")])
            .find(|path| path.is_file());
        match &found {
            Some(wrapper) => println!("GIT_WRAPPER {}", wrapper.display()),
            None => println!(
                r"SKIP: capability git-for-windows-wrapper absent (no %ProgramFiles%\Git\cmd\git.exe or C:\Git\cmd\git.exe)"
            ),
        }
        found
    }

    /// No user or system configuration, and no repository above the fixture folder.
    fn git_environment(fixture: &Fixture) -> Vec<(OsString, OsString)> {
        let mut environment: Vec<(OsString, OsString)> = std::env::vars_os()
            .filter(|(name, _)| {
                !name
                    .to_string_lossy()
                    .to_ascii_uppercase()
                    .starts_with("GIT_")
            })
            .collect();
        let ceiling = fixture.0.parent().expect("fixture parent").as_os_str();
        // Git 2.56 fails with "unable to access 'NUL'" when GIT_CONFIG_GLOBAL names NUL.
        let global = fixture.path("global.gitconfig");
        std::fs::write(&global, "").expect("write an empty global configuration");
        for (name, value) in [
            ("GIT_CONFIG_NOSYSTEM", OsStr::new("1")),
            ("GIT_CONFIG_GLOBAL", global.as_os_str()),
            ("GIT_TERMINAL_PROMPT", OsStr::new("0")),
            ("GIT_CEILING_DIRECTORIES", ceiling),
        ] {
            environment.push((name.into(), value.to_owned()));
        }
        environment
    }

    /// The image file name of a process, without closing or ending it.
    fn image_name(pid: u32) -> Option<String> {
        // SAFETY: the call returns a new handle or fails.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        // SAFETY: OpenProcess returned a new handle that nothing else owns.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        let mut buffer = vec![0u16; COMMAND_LINE_UNITS];
        let mut size = buffer.len() as u32;
        // SAFETY: `buffer` holds `size` UTF-16 units, and `handle` stays open for the call.
        unsafe {
            QueryFullProcessImageNameW(
                raw(&handle),
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
        }
        .ok()?;
        let path = PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize]));
        Some(path.file_name()?.to_string_lossy().into_owned())
    }

    /// Runs `<wrapper> --exec-path` with the shell flags. Returns the Git `git.exe` in that folder.
    fn resolve(wrapper: &Path, fixture: &Fixture) -> PathBuf {
        let job = Job::create().expect("Job");
        let arguments = ["--exec-path".to_string()];
        let environment = git_environment(fixture);
        let spawned = spawn(
            &SpawnRequest {
                program: wrapper,
                arguments: &arguments,
                environment: &environment,
                current_dir: &fixture.0,
                wsl: false,
                input: Input::Closed,
            },
            job.handle(),
        )
        .expect("spawn");
        let _process = Proc {
            handle: spawned.process,
            pid: spawned.pid,
        };
        let _stderr = Lines::new(spawned.stderr);
        let folder = Lines::new(spawned.stdout)
            .line(WAIT)
            .expect("an --exec-path line");
        PathBuf::from(folder.trim_end().replace('/', r"\")).join("git.exe")
    }

    struct Hashing {
        job: Job,
        process: Proc,
        stdin: File,
    }

    /// Starts `hash-object --stdin-paths` with the shell flags and waits for one hash. Git then waits for the next path.
    fn hash_object(program: &Path, fixture: &Fixture) -> Hashing {
        let job = Job::create().expect("Job");
        let arguments = ["hash-object".to_string(), "--stdin-paths".to_string()];
        let environment = git_environment(fixture);
        let spawned = spawn(
            &SpawnRequest {
                program,
                arguments: &arguments,
                environment: &environment,
                current_dir: &fixture.0,
                wsl: false,
                input: Input::Stream,
            },
            job.handle(),
        )
        .expect("spawn");
        let process = Proc {
            handle: spawned.process,
            pid: spawned.pid,
        };
        let _stderr = Lines::new(spawned.stderr);
        let stdout = Lines::new(spawned.stdout);
        let mut stdin = spawned.stdin.expect("stdin");
        writeln!(stdin, "{}", fixture.path("a.txt").display()).expect("write a path");
        stdin.flush().expect("flush");
        let hash = stdout.line(WAIT).expect("a hash line");
        assert!(
            hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "hash: {hash}"
        );
        Hashing {
            job,
            process,
            stdin,
        }
    }

    #[test]
    fn the_exec_path_git_has_no_console_and_the_wrapper_child_has_one() {
        let Some(wrapper) = find_wrapper() else {
            return;
        };
        let fixture = Fixture::new();
        std::fs::write(fixture.path("a.txt"), "a\n").expect("write a file");
        let resolved = resolve(&wrapper, &fixture);
        println!("GIT_RESOLVED {}", resolved.display());
        assert!(resolved.is_file(), "the exec-path folder holds git.exe");

        let direct = hash_object(&resolved, &fixture);
        assert_eq!(
            direct.job.process_ids().expect("process IDs"),
            vec![direct.process.pid],
            "the resolved Git runs alone in its Job, without conhost.exe"
        );
        drop(direct.stdin);
        assert!(direct.process.exits_within(WAIT), "Git ends at end-of-file");

        let wrapped = hash_object(&wrapper, &fixture);
        let mut names = Vec::new();
        let console = eventually(WAIT, || {
            names = wrapped
                .job
                .process_ids()
                .expect("process IDs")
                .into_iter()
                .filter_map(image_name)
                .collect();
            names
                .iter()
                .any(|name| name.eq_ignore_ascii_case("conhost.exe"))
        });
        assert!(
            console,
            "the wrapper starts Git with a hidden console: {names:?}"
        );
        drop(wrapped.stdin);
        assert!(
            wrapped.process.exits_within(WAIT),
            "the wrapper ends at end-of-file"
        );
    }

    #[test]
    fn the_child_reads_exactly_the_input_bytes_and_then_end_of_file() {
        let input: Vec<u8> = (0..65_536u32)
            .map(|i| (i % 256) as u8)
            .chain(*b"\r\n\x1a")
            .take(65_536)
            .collect();
        let job = Job::create().expect("Job");
        let (_, report) = report(&job, &["report"], false, Input::Bytes(&input));
        let expected: String = input.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(report["stdinHex"].as_str().expect("stdin"), expected);
    }

    #[test]
    fn without_input_the_first_stdin_read_is_end_of_file_within_one_second() {
        let job = Job::create().expect("Job");
        let (_, report) = report(&job, &["report"], false, Input::Closed);
        assert_eq!(report["stdinHex"], "", "no bytes");
        assert!(
            report["stdinEofMs"].as_u64().expect("ms") < 1000,
            "end-of-file within 1 s"
        );
    }
}
