use robust_sinkhorn_queue::fs_mutation::{atomic_write, create_directory, probe_root, MutationError};
use std::env;
use std::io::{self, Read};
use std::path::Path;

fn usage() -> ! {
    eprintln!("usage: robust-sinkhorn-fs-mutator <probe|write|mkdir> --root <absolute-root> [--path <relative-path>]");
    std::process::exit(64);
}

fn parse_flag(args: &[String], name: &str) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            return args.get(index + 1).cloned();
        }
        index += 1;
    }
    None
}

fn error_code(error: &MutationError) -> &'static str {
    match error {
        MutationError::InvalidRoot => "invalid_root",
        MutationError::InvalidPath => "invalid_path",
        MutationError::PayloadTooLarge => "payload_too_large",
        MutationError::Io(_) => "mutation_io_error",
    }
}

fn fail(error: MutationError) -> ! {
    eprintln!("{{\"ok\":false,\"error\":\"{}\"}}", error_code(&error));
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let operation = args.first().map(String::as_str).unwrap_or_else(|| usage());
    let root = parse_flag(&args[1..], "--root").unwrap_or_else(|| usage());

    let result = match operation {
        "probe" => probe_root(Path::new(&root)),
        "mkdir" => {
            let path = parse_flag(&args[1..], "--path").unwrap_or_else(|| usage());
            create_directory(Path::new(&root), Path::new(&path))
        }
        "write" => {
            let path = parse_flag(&args[1..], "--path").unwrap_or_else(|| usage());
            let mut bytes = Vec::new();
            let mut limited = io::stdin().take((1024 * 1024 + 1) as u64);
            if limited.read_to_end(&mut bytes).is_err() {
                eprintln!("{\"ok\":false,\"error\":\"stdin_read_error\"}");
                std::process::exit(1);
            }
            atomic_write(Path::new(&root), Path::new(&path), &bytes)
        }
        _ => usage(),
    };

    if let Err(error) = result {
        fail(error);
    }

    println!("{{\"ok\":true,\"operation\":\"{}\"}}", operation);
}
