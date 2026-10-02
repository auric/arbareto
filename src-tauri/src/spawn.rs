// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows::Wdk::System::SystemServices::RtlUpcaseUnicodeChar;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DETACHED_PROCESS, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
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
    /// The start or the Job assignment failed, and no owned process runs. The reply code is `PROCESS_OWNERSHIP_FAILED`.
    OwnershipFailed,
}

/// The stdin of the child (contract §6 "Console and input").
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
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only tests read the process ID")
    )]
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

fn null_terminated(value: &OsStr) -> Result<Vec<u16>, SpawnError> {
    let units: Vec<u16> = value.encode_wide().chain(Some(0)).collect();
    if units[..units.len() - 1].contains(&0) {
        return Err(SpawnError::InvalidArgument);
    }
    Ok(units)
}

/// The block is sorted by name without case, in Unicode order (Microsoft Learn "Changing Environment Variables").
fn environment_block(environment: &[(OsString, OsString)]) -> Result<Vec<u16>, SpawnError> {
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

/// Starts the child suspended, calls `assign` with its process handle, then resumes it.
pub fn spawn(
    request: &SpawnRequest,
    assign: &mut dyn FnMut(HANDLE) -> windows::core::Result<()>,
) -> Result<Spawned, SpawnError> {
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

    let mut size = 0;
    // SAFETY: a size query without a list. It fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
    let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
    // SAFETY: `storage` is pointer-aligned and holds at least `size` bytes.
    unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut size) }
        .map_err(|_| SpawnError::OwnershipFailed)?;
    // SAFETY: `inherited` outlives the list use in CreateProcessW below. The size is that of the array.
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

    // SAFETY: CreateProcessW returned the thread handle, and this function owns it.
    let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread.0) };
    let owned = assign(info.hProcess).is_ok()
        // SAFETY: `thread` is the open primary thread handle of the suspended child.
        && unsafe { ResumeThread(raw(&thread)) } != u32::MAX;
    drop(thread);
    if !owned {
        // SAFETY: this function owns the process handle and closes it once.
        unsafe {
            let _ = TerminateProcess(info.hProcess, 1);
            let _ = CloseHandle(info.hProcess);
        }
        return Err(SpawnError::OwnershipFailed);
    }

    let mut parent_stdin = File::from(parent_stdin);
    let stdin = match request.input {
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
        process: info.hProcess,
        pid: info.dwProcessId,
        stdin,
        stdout: File::from(parent_stdout),
        stderr: File::from(parent_stderr),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::time::Duration;

    use windows::Win32::Foundation::{E_FAIL, HANDLE_FLAG_INHERIT, SetHandleInformation};
    use windows::Win32::System::Threading::{
        CREATE_NEW_CONSOLE, CREATE_NO_WINDOW, CREATE_SUSPENDED, DETACHED_PROCESS, GetProcessId,
    };

    use crate::jobs::Job;
    use crate::jobs::tests::{
        CLOSE_BOUND, Fixture, Lines, Proc, WAIT, child_arguments, final_path, same_path, test_exe,
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
            &mut |process| job.assign(process),
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
        let mut assigned = false;
        let result = spawn(
            &request(program, &units_above, &environment, false, Input::Closed),
            &mut |_| {
                assigned = true;
                Ok(())
            },
        );
        // An attempted start of the absent program would give `OwnershipFailed` instead.
        assert!(
            matches!(result, Err(SpawnError::CommandLineTooLong)),
            "refused before process creation"
        );
        assert!(!assigned, "no process reached the Job assignment");
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
    fn the_child_starts_suspended_joins_its_job_and_then_resumes() {
        let fixture = Fixture::new();
        let started = fixture.path("started.txt");
        let job = Job::create().expect("Job");
        let program = test_exe();
        let arguments = child_arguments(&["started", started.to_str().expect("path")]);
        let environment = environment();
        let mut ran_before_assignment = None;
        let spawned = spawn(
            &request(&program, &arguments, &environment, false, Input::Closed),
            &mut |process| {
                std::thread::sleep(Duration::from_secs(1));
                ran_before_assignment = Some(started.exists());
                job.assign(process)
            },
        )
        .expect("spawn");
        let _process = Proc {
            handle: spawned.process,
            pid: spawned.pid,
        };
        let _stderr = Lines::new(spawned.stderr);
        assert_eq!(
            ran_before_assignment,
            Some(false),
            "the child runs no code before its Job assignment"
        );
        let report: serde_json::Value =
            serde_json::from_str(&Lines::new(spawned.stdout).wait("STARTED", WAIT)).expect("JSON");
        assert_eq!(
            report["jobPids"],
            serde_json::json!([spawned.pid]),
            "after the resume, its immediate Job holds only the child"
        );
    }

    #[test]
    fn an_injected_job_assignment_failure_terminates_the_suspended_child() {
        let program = test_exe();
        let arguments = child_arguments(&["sleep", "60000"]);
        let environment = environment();
        let mut seen = None;
        let result = spawn(
            &request(&program, &arguments, &environment, false, Input::Closed),
            &mut |process| {
                seen = Some(Proc::open(unsafe { GetProcessId(process) }));
                Err(windows::core::Error::from_hresult(E_FAIL))
            },
        );
        assert!(
            matches!(result, Err(SpawnError::OwnershipFailed)),
            "PROCESS_OWNERSHIP_FAILED"
        );
        let child = seen.expect("the hook saw the suspended child");
        assert!(
            child.exits_within(CLOSE_BOUND),
            "the suspended child is terminated"
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
