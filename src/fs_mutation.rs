use rand::random;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path};
use thiserror::Error;

const MAX_RELATIVE_PATH_BYTES: usize = 4096;
const MAX_WRITE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum MutationError {
    #[error("root must be an absolute non-root path without symlink components")]
    InvalidRoot,
    #[error("path must be a bounded relative path without '.', '..', empty, or NUL components")]
    InvalidPath,
    #[error("write payload exceeds 1 MiB")]
    PayloadTooLarge,
    #[error("filesystem mutation failed: {0}")]
    Io(#[from] io::Error),
}

fn cstring(value: &str) -> Result<CString, MutationError> {
    CString::new(value).map_err(|_| MutationError::InvalidPath)
}

fn open_dir_at(parent: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn open_host_root() -> io::Result<OwnedFd> {
    let slash = CStr::from_bytes_with_nul(b"/\0").expect("static root path");
    let fd = unsafe {
        libc::open(
            slash.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn strict_components(path: &Path, absolute: bool) -> Result<Vec<CString>, MutationError> {
    let raw = path.to_str().ok_or(if absolute {
        MutationError::InvalidRoot
    } else {
        MutationError::InvalidPath
    })?;
    if raw.as_bytes().len() > MAX_RELATIVE_PATH_BYTES || raw.as_bytes().contains(&0) {
        return Err(if absolute {
            MutationError::InvalidRoot
        } else {
            MutationError::InvalidPath
        });
    }

    let mut output = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir if absolute => {}
            Component::Normal(value) => {
                let text = value.to_str().ok_or(if absolute {
                    MutationError::InvalidRoot
                } else {
                    MutationError::InvalidPath
                })?;
                if text.is_empty() {
                    return Err(if absolute {
                        MutationError::InvalidRoot
                    } else {
                        MutationError::InvalidPath
                    });
                }
                output.push(cstring(text)?);
            }
            _ => {
                return Err(if absolute {
                    MutationError::InvalidRoot
                } else {
                    MutationError::InvalidPath
                });
            }
        }
    }
    if output.is_empty() {
        return Err(if absolute {
            MutationError::InvalidRoot
        } else {
            MutationError::InvalidPath
        });
    }
    Ok(output)
}

fn open_root(root: &Path) -> Result<OwnedFd, MutationError> {
    if !root.is_absolute() || root == Path::new("/") {
        return Err(MutationError::InvalidRoot);
    }
    let components = strict_components(root, true)?;
    let mut current = open_host_root()?;
    for component in components {
        current = open_dir_at(current.as_raw_fd(), &component)?;
    }
    Ok(current)
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
        current = open_dir_at(current.as_raw_fd(), &component)?;
    }
    Ok((current, leaf))
}

fn fsync_fd(fd: RawFd) -> io::Result<()> {
    let rc = unsafe { libc::fsync(fd) };
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unlinkat_best_effort(parent: RawFd, name: &CStr) {
    unsafe {
        libc::unlinkat(parent, name.as_ptr(), 0);
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
            libc::openat(
                parent_fd,
                candidate.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC,
                0o600,
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

    let write_result = (|| -> Result<(), MutationError> {
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        let rc = unsafe {
            libc::renameat(
                parent_fd,
                temp_name.as_ptr(),
                parent_fd,
                leaf.as_ptr(),
            )
        };
        if rc < 0 {
            return Err(io::Error::last_os_error().into());
        }
        fsync_fd(parent_fd)?;
        Ok(())
    })();

    if write_result.is_err() {
        unlinkat_best_effort(parent_fd, &temp_name);
    }
    write_result
}

pub fn create_directory(root: &Path, relative_path: &Path) -> Result<(), MutationError> {
    let (parent, leaf) = open_parent(root, relative_path)?;
    let rc = unsafe { libc::mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700) };
    if rc < 0 {
        return Err(io::Error::last_os_error().into());
    }
    fsync_fd(parent.as_raw_fd())?;
    Ok(())
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
        assert!(matches!(probe_root(Path::new("/")), Err(MutationError::InvalidRoot)));
        symlink(&fixture.root, fixture.base.join("root-link")).unwrap();
        assert!(probe_root(&fixture.base.join("root-link")).is_err());
    }

    #[test]
    fn writes_atomically_inside_opened_parent() {
        let fixture = Fixture::new();
        atomic_write(&fixture.root, Path::new("nested/file.txt"), b"first\n").unwrap();
        assert_eq!(fs::read(fixture.root.join("nested/file.txt")).unwrap(), b"first\n");
        atomic_write(&fixture.root, Path::new("nested/file.txt"), b"second\n").unwrap();
        assert_eq!(fs::read(fixture.root.join("nested/file.txt")).unwrap(), b"second\n");
    }

    #[test]
    fn replaces_a_leaf_symlink_without_following_it() {
        let fixture = Fixture::new();
        let outside_file = fixture.outside.join("secret.txt");
        symlink(&outside_file, fixture.root.join("nested/link.txt")).unwrap();
        atomic_write(&fixture.root, Path::new("nested/link.txt"), b"inside\n").unwrap();
        assert_eq!(fs::read(&outside_file).unwrap(), b"outside\n");
        assert_eq!(fs::read(fixture.root.join("nested/link.txt")).unwrap(), b"inside\n");
    }

    #[test]
    fn rejects_symlinked_parent_components() {
        let fixture = Fixture::new();
        symlink(&fixture.outside, fixture.root.join("escape")).unwrap();
        let error = atomic_write(&fixture.root, Path::new("escape/pwned.txt"), b"no\n")
            .expect_err("symlink parent must fail");
        assert!(matches!(error, MutationError::Io(_)));
        assert!(!fixture.outside.join("pwned.txt").exists());
    }

    #[test]
    fn rejects_parent_traversal_and_host_root() {
        let fixture = Fixture::new();
        assert!(matches!(
            atomic_write(&fixture.root, Path::new("../outside/pwned.txt"), b"no\n"),
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
