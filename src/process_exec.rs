use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use thiserror::Error;

const MAX_PATH_BYTES: usize = 4096;
const MAX_ARGUMENTS: usize = 16;
const MAX_ARGUMENT_BYTES: usize = 1024;
const ELF_MAGIC: &[u8; 4] = b"\x7fELF";

#[cfg(any(target_os = "linux", target_os = "android"))]
mod sys {
    use std::os::raw::{c_char, c_int, c_long};

    pub const O_RDONLY: c_int = 0;
    #[cfg(target_os = "linux")]
    pub const O_DIRECTORY: c_int = 0o200000;
    #[cfg(target_os = "linux")]
    pub const O_NOFOLLOW: c_int = 0o400000;
    #[cfg(target_os = "android")]
    pub const O_DIRECTORY: c_int = 0o40000;
    #[cfg(target_os = "android")]
    pub const O_NOFOLLOW: c_int = 0o100000;
    pub const O_CLOEXEC: c_int = 0o2000000;
    pub const O_PATH: c_int = 0o10000000;
    pub const AT_EMPTY_PATH: c_int = 0x1000;

    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    pub const SYS_EXECVEAT: c_long = 322;
    #[cfg(target_arch = "aarch64")]
    pub const SYS_EXECVEAT: c_long = 281;

    unsafe extern "C" {
        pub fn open(path: *const c_char, flags: c_int, ...) -> c_int;
        pub fn openat(dirfd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        pub fn fchdir(fd: c_int) -> c_int;
        pub fn syscall(number: c_long, ...) -> c_long;
    }
}

#[cfg(not(any(
    all(target_arch = "x86_64", target_os = "linux"),
    all(target_arch = "aarch64", any(target_os = "linux", target_os = "android"))
)))]
compile_error!("fd-bound process execution currently supports Linux x86_64/aarch64 and Android aarch64 only");

#[derive(Debug, Error)]
pub enum ProcessExecError {
    #[error("process path must be an absolute non-root path without symlink components")]
    InvalidPath,
    #[error("registered process binary must be an executable native ELF regular file")]
    InvalidExecutable,
    #[error("registered process argument contract is invalid")]
    InvalidArgument,
    #[error("fd-bound process operation failed: {0}")]
    Io(#[from] io::Error),
}

fn strict_absolute_components(path: &Path) -> Result<Vec<CString>, ProcessExecError> {
    let raw = path.to_str().ok_or(ProcessExecError::InvalidPath)?;
    if raw.is_empty()
        || raw == "/"
        || raw.len() > MAX_PATH_BYTES
        || !raw.starts_with('/')
        || raw.as_bytes().contains(&0)
        || raw.contains('\\')
    {
        return Err(ProcessExecError::InvalidPath);
    }

    let mut output = Vec::new();
    for segment in raw[1..].split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(ProcessExecError::InvalidPath);
        }
        output.push(CString::new(segment).map_err(|_| ProcessExecError::InvalidPath)?);
    }
    if output.is_empty() {
        return Err(ProcessExecError::InvalidPath);
    }
    Ok(output)
}

fn open_host_root() -> io::Result<OwnedFd> {
    let fd = unsafe {
        sys::open(
            c"/".as_ptr(),
            sys::O_PATH | sys::O_DIRECTORY | sys::O_NOFOLLOW | sys::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn open_path_dir_at(parent: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    let fd = unsafe {
        sys::openat(
            parent,
            name.as_ptr(),
            sys::O_PATH | sys::O_DIRECTORY | sys::O_NOFOLLOW | sys::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn snapshot_directory_identity(path: &Path) -> Result<(u64, u64), ProcessExecError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ProcessExecError::InvalidPath)?;
    if !metadata.is_dir() {
        return Err(ProcessExecError::InvalidPath);
    }
    Ok((metadata.dev(), metadata.ino()))
}

pub fn open_cwd_for_exec(path: &Path) -> Result<OwnedFd, ProcessExecError> {
    let expected = snapshot_directory_identity(path)?;
    let components = strict_absolute_components(path)?;
    let mut current = open_host_root()?;
    for component in components {
        current = open_path_dir_at(current.as_raw_fd(), &component)?;
    }

    let path_fd = File::from(current);
    let opened = path_fd.metadata()?;
    if !opened.is_dir() || (opened.dev(), opened.ino()) != expected {
        return Err(ProcessExecError::InvalidPath);
    }

    let fd = unsafe {
        sys::openat(
            path_fd.as_raw_fd(),
            c".".as_ptr(),
            sys::O_RDONLY | sys::O_DIRECTORY | sys::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let readable = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let actual = readable.metadata()?;
    if !actual.is_dir() || (actual.dev(), actual.ino()) != expected {
        return Err(ProcessExecError::InvalidPath);
    }

    Ok(readable.into())
}

pub fn open_executable_for_exec(path: &Path) -> Result<OwnedFd, ProcessExecError> {
    let snapshot = fs::symlink_metadata(path).map_err(|_| ProcessExecError::InvalidExecutable)?;
    if !snapshot.is_file() || snapshot.permissions().mode() & 0o111 == 0 {
        return Err(ProcessExecError::InvalidExecutable);
    }
    let expected = (snapshot.dev(), snapshot.ino());

    let mut components = strict_absolute_components(path)?;
    let leaf = components.pop().ok_or(ProcessExecError::InvalidPath)?;
    let mut parent = open_host_root()?;
    for component in components {
        parent = open_path_dir_at(parent.as_raw_fd(), &component)?;
    }

    let fd = unsafe {
        sys::openat(
            parent.as_raw_fd(),
            leaf.as_ptr(),
            sys::O_RDONLY | sys::O_NOFOLLOW | sys::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(ProcessExecError::InvalidExecutable);
    }

    let mut file = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o111 == 0
        || (metadata.dev(), metadata.ino()) != expected
    {
        return Err(ProcessExecError::InvalidExecutable);
    }

    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|_| ProcessExecError::InvalidExecutable)?;
    if &magic != ELF_MAGIC {
        return Err(ProcessExecError::InvalidExecutable);
    }

    Ok(file.into())
}

fn c_arguments(binary: &Path, arguments: &[String]) -> Result<(Vec<CString>, Vec<*const i8>), ProcessExecError> {
    if arguments.len() > MAX_ARGUMENTS {
        return Err(ProcessExecError::InvalidArgument);
    }
    let binary_text = binary.to_str().ok_or(ProcessExecError::InvalidArgument)?;
    let mut values = Vec::with_capacity(arguments.len() + 1);
    values.push(CString::new(binary_text).map_err(|_| ProcessExecError::InvalidArgument)?);
    for argument in arguments {
        if argument.as_bytes().contains(&0) || argument.as_bytes().len() > MAX_ARGUMENT_BYTES {
            return Err(ProcessExecError::InvalidArgument);
        }
        values.push(CString::new(argument.as_str()).map_err(|_| ProcessExecError::InvalidArgument)?);
    }
    let mut pointers: Vec<*const i8> = values.iter().map(|value| value.as_ptr()).collect();
    pointers.push(std::ptr::null());
    Ok((values, pointers))
}

pub fn exec_fd_bound(
    binary: &Path,
    cwd: &Path,
    arguments: &[String],
) -> Result<(), ProcessExecError> {
    let executable = open_executable_for_exec(binary)?;
    let cwd_fd = open_cwd_for_exec(cwd)?;
    let (_argument_storage, argument_pointers) = c_arguments(binary, arguments)?;

    let environment = [
        CString::new("LANG=C").expect("constant contains no NUL"),
        CString::new("LC_ALL=C").expect("constant contains no NUL"),
        CString::new("PATH=/nonexistent").expect("constant contains no NUL"),
    ];
    let mut environment_pointers: Vec<*const i8> =
        environment.iter().map(|value| value.as_ptr()).collect();
    environment_pointers.push(std::ptr::null());

    if unsafe { sys::fchdir(cwd_fd.as_raw_fd()) } < 0 {
        return Err(io::Error::last_os_error().into());
    }

    let empty = c"";
    let rc = unsafe {
        sys::syscall(
            sys::SYS_EXECVEAT,
            executable.as_raw_fd(),
            empty.as_ptr(),
            argument_pointers.as_ptr(),
            environment_pointers.as_ptr(),
            sys::AT_EMPTY_PATH,
        )
    };
    if rc < 0 {
        return Err(io::Error::last_os_error().into());
    }

    unreachable!("execveat returned success without replacing the process")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::random;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture {
        base: std::path::PathBuf,
        executable: std::path::PathBuf,
        cwd: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "tqq-process-exec-{}-{:016x}",
                std::process::id(),
                random::<u64>()
            ));
            let cwd = base.join("cwd");
            fs::create_dir_all(&cwd).unwrap();

            let source = std::env::current_exe().unwrap();
            let executable = base.join("proof-elf");
            fs::copy(source, &executable).unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            Self { base, executable, cwd }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn opens_only_native_regular_executables_without_symlinks() {
        let fixture = Fixture::new();
        open_executable_for_exec(&fixture.executable).unwrap();

        let link = fixture.base.join("proof-link");
        symlink(&fixture.executable, &link).unwrap();
        assert!(open_executable_for_exec(&link).is_err());

        let script = fixture.base.join("script");
        fs::write(&script, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            open_executable_for_exec(&script),
            Err(ProcessExecError::InvalidExecutable)
        ));
    }

    #[test]
    fn executable_fd_pins_inode_across_namespace_replacement() {
        let fixture = Fixture::new();
        let fd = open_executable_for_exec(&fixture.executable).unwrap();
        let opened = File::from(fd);
        let opened_metadata = opened.metadata().unwrap();

        let moved = fixture.base.join("opened-elf");
        fs::rename(&fixture.executable, &moved).unwrap();
        fs::write(&fixture.executable, b"not an executable\n").unwrap();

        let moved_metadata = fs::metadata(&moved).unwrap();
        let replacement_metadata = fs::metadata(&fixture.executable).unwrap();
        assert_eq!(
            (opened_metadata.dev(), opened_metadata.ino()),
            (moved_metadata.dev(), moved_metadata.ino())
        );
        assert_ne!(
            (opened_metadata.dev(), opened_metadata.ino()),
            (replacement_metadata.dev(), replacement_metadata.ino())
        );
    }

    #[test]
    fn cwd_is_opened_as_exact_directory_identity() {
        let fixture = Fixture::new();
        open_cwd_for_exec(&fixture.cwd).unwrap();
        let link = fixture.base.join("cwd-link");
        symlink(&fixture.cwd, &link).unwrap();
        assert!(open_cwd_for_exec(&link).is_err());
    }
}
