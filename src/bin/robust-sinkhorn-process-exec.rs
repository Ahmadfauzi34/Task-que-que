use robust_sinkhorn_queue::process_exec::exec_fd_bound;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn usage() -> ! {
    eprintln!("usage: robust-sinkhorn-process-exec --binary ABS --cwd ABS -- [ARG ...]");
    std::process::exit(64);
}

fn self_proof_child(arguments: &[String]) -> ! {
    if arguments.len() != 2 {
        std::process::exit(65);
    }
    println!("fd_bound_child=OK");
    println!("marker={}", arguments[1]);
    println!("cwd={}", std::env::current_dir().unwrap().display());
    println!("lang={}", std::env::var("LANG").unwrap_or_default());
    println!("lc_all={}", std::env::var("LC_ALL").unwrap_or_default());
    println!("path={}", std::env::var("PATH").unwrap_or_default());
    println!(
        "leaked={}",
        std::env::var("TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK").unwrap_or_else(|_| "ABSENT".into())
    );
    std::process::exit(0);
}

fn self_proof_sleep(arguments: &[String]) -> ! {
    if arguments.len() != 1 {
        std::process::exit(66);
    }
    loop {
        thread::sleep(Duration::from_secs(3_600));
    }
}

fn self_proof_tree(arguments: &[String]) -> ! {
    if arguments.len() != 2 {
        std::process::exit(67);
    }

    let executable = std::env::current_exe().unwrap_or_else(|_| std::process::exit(68));
    let mut child = Command::new(executable)
        .arg("--self-proof-sleep")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|_| std::process::exit(69));

    fs::write(&arguments[1], format!("{}\n", child.id()))
        .unwrap_or_else(|_| std::process::exit(71));

    let _ = child.wait();
    std::process::exit(72);
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("--self-proof-child") => self_proof_child(&arguments),
        Some("--self-proof-tree") => self_proof_tree(&arguments),
        Some("--self-proof-sleep") => self_proof_sleep(&arguments),
        _ => {}
    }

    if arguments.len() < 5
        || arguments[0] != "--binary"
        || arguments[2] != "--cwd"
        || arguments[4] != "--"
    {
        usage();
    }

    let binary = &arguments[1];
    let cwd = &arguments[3];
    let child_arguments = arguments[5..].to_vec();

    if let Err(error) = exec_fd_bound(Path::new(binary), Path::new(cwd), &child_arguments) {
        eprintln!("fd-bound exec failed: {error}");
        std::process::exit(70);
    }
}
