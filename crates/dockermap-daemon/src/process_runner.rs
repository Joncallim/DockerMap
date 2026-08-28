//! Bounded execution for fixed, read-only runtime-provider commands.
//!
//! This module intentionally accepts a pre-built [`std::process::Command`].
//! Providers own their fixed command lines; this boundary supplies null stdin,
//! bounded pipe draining, and group-wide timeout cleanup without a shell.

use std::{
    os::unix::process::CommandExt,
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

/// Maximum stdout/stderr retained for one provider command. Readers continue
/// draining after this cap so a noisy provider cannot block on a full pipe.
pub(crate) const MAX_PROVIDER_OUTPUT_BYTES: usize = 1 << 20;

/// Wall-clock budget for each fixed provider subprocess.
pub(crate) const PROVIDER_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug)]
pub(crate) struct BoundedRead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}

#[derive(Debug)]
pub(crate) struct ProviderCommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stdout_truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderCommandError {
    Spawn,
    Wait,
    Reader,
    TimedOut(Duration),
}

impl ProviderCommandError {
    pub(crate) fn is_spawn(self) -> bool {
        matches!(self, Self::Spawn)
    }
}

impl std::fmt::Display for ProviderCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn => formatter.write_str("provider command unavailable"),
            Self::Wait => formatter.write_str("provider command wait failed"),
            Self::Reader => formatter.write_str("provider command output reader failed"),
            Self::TimedOut(timeout) => {
                write!(
                    formatter,
                    "provider command timed out after {}s",
                    timeout.as_secs()
                )
            }
        }
    }
}

/// Run a provider command with a hard wall-clock timeout. Returns the child's
/// output on success; `Err` on spawn failure or when the command outlives the
/// budget (the child is killed and reaped). Callers push a provider diagnostic
/// instead of failing the whole runtime map.
///
/// Pipes are drained by reader threads while the child runs, so a provider
/// whose output exceeds the pipe buffer cannot deadlock before its timeout.
pub(crate) fn run_command_with_timeout(
    command: Command,
    timeout: Duration,
) -> Result<ProviderCommandOutput, ProviderCommandError> {
    run_command_with_timeout_started(command, timeout, Instant::now())
}

/// The explicit `started` argument keeps the deadline anchored before spawn.
/// It is also a deterministic seam for testing a slow `posix_spawnp` path.
pub(crate) fn run_command_with_timeout_started(
    mut command: Command,
    timeout: Duration,
    started: Instant,
) -> Result<ProviderCommandOutput, ProviderCommandError> {
    // `Command::spawn` does not pipe stdio like `Command::output` does, so
    // request them explicitly. A process group makes a timeout cover
    // descendants retaining pipe handles, not just the immediate provider.
    command.process_group(0);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ProviderCommandError::Spawn)?;

    if started.elapsed() >= timeout {
        terminate_provider_process_group(&mut child);
        return Err(ProviderCommandError::TimedOut(timeout));
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    let mut stdout_reader = Some(std::thread::spawn(move || {
        let _ = stdout_sender.send(read_bounded(stdout, MAX_PROVIDER_OUTPUT_BYTES));
    }));
    let mut stderr_reader = Some(std::thread::spawn(move || {
        let _ = stderr_sender.send(read_bounded(stderr, MAX_PROVIDER_OUTPUT_BYTES));
    }));

    let status = loop {
        let waited = match child.try_wait() {
            Ok(waited) => waited,
            Err(_) => {
                terminate_provider_process_group(&mut child);
                return Err(ProviderCommandError::Wait);
            }
        };
        match waited {
            Some(status) => break Some(status),
            None if started.elapsed() >= timeout => {
                terminate_provider_process_group(&mut child);
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };

    let deadline = started + timeout;
    let stdout = receive_reader_until(&stdout_receiver, deadline);
    let stderr = receive_reader_until(&stderr_receiver, deadline);
    let reader_timed_out = stdout.is_none() || stderr.is_none();
    if reader_timed_out && status.is_some() {
        // A forked child may retain pipes after the command exits. Kill the
        // whole group to let readers finish instead of pinning collection.
        terminate_provider_process_group(&mut child);
    }

    let stdout_received = stdout.is_some();
    let stderr_received = stderr.is_some();
    if stdout_received {
        let _ = stdout_reader.take().expect("stdout reader present").join();
    }
    if stderr_received {
        let _ = stderr_reader.take().expect("stderr reader present").join();
    }
    if let (Some(stdout), Some(_stderr)) = (stdout, stderr) {
        return match status {
            Some(status) => Ok(ProviderCommandOutput {
                status,
                stdout: stdout.bytes,
                stdout_truncated: stdout.truncated,
            }),
            None => Err(ProviderCommandError::TimedOut(timeout)),
        };
    }

    // After the group kill, join only readers that have already completed; an
    // undelivered reader is detached and sees EOF once descendants exit.
    if !stdout_received && stdout_receiver.try_recv().is_ok() {
        let _ = stdout_reader.take().expect("stdout reader present").join();
    }
    if !stderr_received && stderr_receiver.try_recv().is_ok() {
        let _ = stderr_reader.take().expect("stderr reader present").join();
    }
    Err(if reader_timed_out {
        ProviderCommandError::TimedOut(timeout)
    } else {
        ProviderCommandError::Reader
    })
}

fn receive_reader_until(
    receiver: &mpsc::Receiver<BoundedRead>,
    deadline: Instant,
) -> Option<BoundedRead> {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
}

fn terminate_provider_process_group(child: &mut std::process::Child) {
    let process_group = child.id() as i32;
    if process_group > 0 {
        // `process_group(0)` makes the provider the group leader. A negative
        // pid targets descendants that inherited stdout/stderr.
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Keep up to `cap` bytes while draining the remainder, preventing a noisy
/// provider from blocking on its full pipe.
pub(crate) fn read_bounded(mut reader: impl std::io::Read, cap: usize) -> BoundedRead {
    let mut buffer = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = cap.saturating_sub(buffer.len());
                let kept = read.min(remaining);
                buffer.extend_from_slice(&chunk[..kept]);
                if read > remaining {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    BoundedRead {
        bytes: buffer,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_reader_caps_retained_bytes_while_draining() {
        let read = read_bounded(std::io::Cursor::new(vec![b'x'; 32]), 16);
        assert_eq!(read.bytes, vec![b'x'; 16]);
        assert!(read.truncated);
    }

    #[test]
    fn timeout_starts_before_spawn_and_kills_pipe_holding_descendants() {
        let started_before_spawn = Instant::now() - Duration::from_millis(200);
        let mut fast_command = Command::new("sh");
        fast_command.arg("-c").arg("echo should-not-complete");
        let delayed_spawn_error = run_command_with_timeout_started(
            fast_command,
            Duration::from_millis(50),
            started_before_spawn,
        )
        .expect_err("a delayed spawn exhausts the existing provider budget");
        assert_eq!(
            delayed_spawn_error,
            ProviderCommandError::TimedOut(Duration::from_millis(50))
        );

        let started = Instant::now();
        let mut pipe_holder = Command::new("sh");
        pipe_holder.arg("-c").arg("sleep 30 & exit 0");
        let error = run_command_with_timeout(pipe_holder, Duration::from_millis(200))
            .expect_err("a child retaining the pipes must time out");
        assert_eq!(
            error,
            ProviderCommandError::TimedOut(Duration::from_millis(200))
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a pipe holder must not block reader joins: {:?}",
            started.elapsed()
        );
    }
}
