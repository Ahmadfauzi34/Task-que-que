use rand::random;
use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use thiserror::Error;

#[cfg(any(target_os = "linux", target_os = "android"))]
mod sys {
    use std::os::raw::{c_char, c_int, c_uint};

    pub const O_RDONLY: c_int = 0;
    pub const O_WRONLY: c_int = 0o1;
    pub const O_CREAT: c_int = 0o100;
    pub const O_EXCL: c_int = 0o200;
    pub const O_DIRECTORY: c_int = 0o200000;
    pub const O_NOFOLLOW: c_int = 0o400000;
    pub const O_CLOEXEC: c_int = 0o2000000;
    pub const O_PATH: c_int = 0o10000000;

    unsafe extern "C" {
        pub fn open(path: *const c_char, flags: c_int, ...) -> c_int;
        pub fn openat(dirfd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        pub fn fsync(fd: c_int) -> c_int;
        pub fn unlinkat(dirfd: c_int, pathname: *const c_char, flags: c_int) -> c_int;
        pub fn renameat(
            olddirfd: c_int,
            oldpath: *const c_char,
            newdirfd: c_int,
            newpath: *const c_char,
        ) -> c_int;
        pub fn mkdirat(dirfd: c_int, pathname: *const c_char, mode: c_uint) -> c_int;
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
compile_error!("fd-relative filesystem mutation substrate currently supports Linux and Android only");

const MAX_PATH_BYTES: usize = 4096;
const MAX_WRITE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum MutationError {
    #[error("root must be an absolute non-root path without symlink components")]
    InvalidRoot,
    #[error("path must be a bounded relative path without '.', '..', empty, backslash, or NUL components")]
    InvalidPath,
    #[error("write payload exceeds 1 MiB")]
    PayloadTooLarge,
    #[error("filesystem mutation committed but parent durability could not be proven: {0}")]
    CommittedDurabilityUnknown(io::Error),
    #[error("filesystem mutation failed: {0}")]
    Io(#[from] io::Error),
}

fn invalid_path(absolute: bool) -> MutationError {
    if absolute {
        MutationError::InvalidRoot
    } else {
        MutationError::InvalidPath
    }
}

fn strict_components(path: &Path, absolute: bool) -> Result<Vec<CString>, MutationError> {
    let raw = path.to_str().ok_or_else(|| invalid_path(absolute))?;
    if raw.is_empty()
        || raw.len() > MAX_PATH_BYTES
        || raw.as_bytes().contains(&0)
        || raw.contains('\\')
    {
        return Err(invalid_path(absolute));
    }

    let body = if absolute {
        if !raw.starts_with('/') || raw == "/" {
            return Err(MutationError::InvalidRoot);
        }
        &raw[1..]
    } else {
        if raw.starts_with('/') {
            return Err(MutationError::InvalidPath);
        }
        raw
    };

    let mut output = Vec::new();
    for segment in body.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(invalid_path(absolute));
        }
        output.push(CString::new(segment).map_err(|_| invalid_path(absolute))?);
    }
    if output.is_empty() {
        return Err(invalid_path(absolute));
    }
    Ok(output)
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
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn open_readable_parent(parent: RawFd) -> io::Result<OwnedFd> {
    let fd = unsafe {
        sys::openat(
            parent,
            c".".as_ptr(),
            sys::O_RDONLY | sys::O_DIRECTORY | sys::O_NOFOLLOW | sys::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn open_host_root() -> io::Result<OwnedFd> {
    let fd = unsafe {
        sys::open(
            c"/".as_ptr(),
            sys::O_PATH | sys::O_DIRECTORY | sys::O_NOFOLLOW | sys::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn directory_identity(path: &Path) -> Result<(u64, u64), MutationError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| MutationError::InvalidRoot)?;
    if !metadata.is_dir() {
        return Err(MutationError::InvalidRoot);
    }
    Ok((metadata.dev(), metadata.ino()))
}

fn open_root(root: &Path) -> Result<OwnedFd, MutationError> {
    if !root.is_absolute() || root == Path::new("/") {
        return Err(MutationError::InvalidRoot);
    }

    // Snapshot the configured terminal object without following a final
    // symlink, then require fd-relative traversal to land on that exact
    // directory inode. This is intentionally independent of Android's
    // O_PATH/O_NOFOLLOW handling for a terminal symlink.
    let expected_identity = directory_identity(root)?;

    let components = strict_components(root, true)?;
    let mut current = open_host_root()?;
    for component in components {
        current = open_path_dir_at(current.as_raw_fd(), &component)?;
    }

    let file = File::from(current);
    let opened_metadata = file.metadata().map_err(|_| MutationError::InvalidRoot)?;
    if !opened_metadata.is_dir()
        || (opened_metadata.dev(), opened_metadata.ino()) != expected_identity
    {
        return Err(MutationError::InvalidRoot);
    }

    // Re-read the operator-configured name after opening. This rejects an
    // ordinary namespace change between snapshot and open. A hostile same-UID
    // process able to race and restore namespace state remains outside the
    // documented threat boundary of this substrate.
    if directory_identity(root)? != expected_identity {
        return Err(MutationError::InvalidRoot);
    }

    Ok(file.into())
}

pub fn probe_root(root: &Path) -> Result<(), MutationError> {
    let _root_fd = open_root(root)?;
    Ok(())
}

fn open_parent(root: &Path, relative_path: &Path) -> Result<(OwnedFd, CString), MutationError> {
    if relative_path.is_absolute() {
        return Err(MutationError::InvalidPath);
    }
    let mut components = strict_components(relative_path, false)?;
    let leaf = components.pop().ok_or(MutationError::InvalidPath)?;
    let mut current = open_root(root)?;
    for component in components {
        current = open_path_dir_at(current.as_raw_fd(), &component)?;
    }
    let writable_parent = open_readable_parent(current.as_raw_fd())?;
    Ok((writable_parent, leaf))
}

fn fsync_fd(fd: RawFd) -> io::Result<()> {
    let rc = unsafe { sys::fsync(fd) };
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unlinkat_best_effort(parent: RawFd, name: &CStr) {
    unsafe {
        sys::unlinkat(parent, name.as_ptr(), 0);
    }
}

pub fn atomic_write(root: &Path, relative_path: &Path, bytes: &[u8]) -> Result<(), MutationError> {
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(MutationError::PayloadTooLarge);
    }
    let (parent, leaf) = open_parent(root, relative_path)?;
    let parent_fd = parent.as_raw_fd();

    let mut temp_name = None;
    let mut temp_fd = None;
    for _ in 0..32 {
        let candidate = CString::new(format!(
            ".tqq-write-{}-{:016x}",
            std::process::id(),
            random::<u64>()
        ))
        .expect("generated temp name contains no NUL");
        let fd = unsafe {
            sys::openat(
                parent_fd,
                candidate.as_ptr(),
                sys::O_WRONLY
                    | sys::O_CREAT
                    | sys::O_EXCL
                    | sys::O_NOFOLLOW
                    | sys::O_CLOEXEC,
                0o600_u32,
            )
        };
        if fd >= 0 {
            temp_name = Some(candidate);
            temp_fd = Some(fd);
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
    }

    let temp_name = temp_name.ok_or_else(|| {
        MutationError::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate unique temporary file",
        ))
    })?;
    let fd = temp_fd.expect("temp fd exists with temp name");

    let precommit = (|| -> Result<(), MutationError> {
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        let rc = unsafe {
            sys::renameat(
                parent_fd,
                temp_name.as_ptr(),
                parent_fd,
                leaf.as_ptr(),
            )
        };
        if rc < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(())
    })();

    if let Err(error) = precommit {
        unlinkat_best_effort(parent_fd, &temp_name);
        return Err(error);
    }

    fsync_fd(parent_fd).map_err(MutationError::CommittedDurabilityUnknown)
}

pub fn create_directory(root: &Path, relative_path: &Path) -> Result<(), MutationError> {
    let (parent, leaf) = open_parent(root, relative_path)?;
    let rc = unsafe { sys::mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700_u32) };
    if rc < 0 {
        return Err(io::Error::last_os_error().into());
    }
    fsync_fd(parent.as_raw_fd()).map_err(MutationError::CommittedDurabilityUnknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        outside: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "tqq-fs-mutation-{}-{:016x}",
                std::process::id(),
                random::<u64>()
            ));
            let root = base.join("root");
            let outside = base.join("outside");
            fs::create_dir_all(root.join("nested")).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("secret.txt"), b"outside\n").unwrap();
            Self { base, root, outside }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn probes_only_non_root_directories_without_symlink_components() {
        let fixture = Fixture::new();
        probe_root(&fixture.root).unwrap();
        assert!(matches!(
            probe_root(Path::new("/")),
            Err(MutationError::InvalidRoot)
        ));
        symlink(&fixture.root, fixture.base.join("root-link")).unwrap();
        assert!(probe_root(&fixture.base.join("root-link")).is_err());
    }

    #[test]
    fn rejects_ambiguous_or_normalized_away_path_segments() {
        let fixture = Fixture::new();
        for path in [
            "./file",
            "nested//file",
            "nested/./file",
            "nested/../file",
            "nested/",
        ] {
            assert!(matches!(
                atomic_write(&fixture.root, Path::new(path), b"no\n"),
                Err(MutationError::InvalidPath)
            ));
        }
    }

    #[test]
    fn writes_atomically_inside_opened_parent() {
        let fixture = Fixture::new();
        atomic_write(&fixture.root, Path::new("nested/file.txt"), b"first\n").unwrap();
        assert_eq!(
            fs::read(fixture.root.join("nested/file.txt")).unwrap(),
            b"first\n"
        );
        atomic_write(&fixture.root, Path::new("nested/file.txt"), b"second\n").unwrap();
        assert_eq!(
            fs::read(fixture.root.join("nested/file.txt")).unwrap(),
            b"second\n"
        );
    }

    #[test]
    fn replaces_a_leaf_symlink_without_following_it() {
        let fixture = Fixture::new();
        let outside_file = fixture.outside.join("secret.txt");
        symlink(&outside_file, fixture.root.join("nested/link.txt")).unwrap();
        atomic_write(
            &fixture.root,
            Path::new("nested/link.txt"),
            b"inside\n",
        )
        .unwrap();
        assert_eq!(fs::read(&outside_file).unwrap(), b"outside\n");
        assert_eq!(
            fs::read(fixture.root.join("nested/link.txt")).unwrap(),
            b"inside\n"
        );
    }

    #[test]
    fn rejects_symlinked_parent_components() {
        let fixture = Fixture::new();
        symlink(&fixture.outside, fixture.root.join("escape")).unwrap();
        let error = atomic_write(
            &fixture.root,
            Path::new("escape/pwned.txt"),
            b"no\n",
        )
        .expect_err("symlink parent must fail");
        assert!(matches!(error, MutationError::Io(_)));
        assert!(!fixture.outside.join("pwned.txt").exists());
    }

    #[test]
    fn rejects_parent_traversal_and_host_root() {
        let fixture = Fixture::new();
        assert!(matches!(
            atomic_write(
                &fixture.root,
                Path::new("../outside/pwned.txt"),
                b"no\n"
            ),
            Err(MutationError::InvalidPath)
        ));
        assert!(matches!(
            atomic_write(Path::new("/"), Path::new("tmp/pwned.txt"), b"no\n"),
            Err(MutationError::InvalidRoot)
        ));
    }

    #[test]
    fn creates_directories_without_following_parent_symlinks() {
        let fixture = Fixture::new();
        create_directory(&fixture.root, Path::new("nested/new-dir")).unwrap();
        assert!(fixture.root.join("nested/new-dir").is_dir());

        symlink(&fixture.outside, fixture.root.join("escape-dir")).unwrap();
        assert!(create_directory(&fixture.root, Path::new("escape-dir/new-dir")).is_err());
        assert!(!fixture.outside.join("new-dir").exists());
    }
}
