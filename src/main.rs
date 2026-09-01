use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::time::Duration;

use robust_sinkhorn_queue::local_api::{serve_connection, LocalApiState};
use robust_sinkhorn_queue::runtime::{run_dispatcher_loop, spawn_worker_slots};
use robust_sinkhorn_queue::tokio_queue::AsyncRobustSinkhornQueue;
use robust_sinkhorn_queue::value::{
    ClaimedTask, EnqueueCommand, Epsilon, LeaseDuration, MaxRetries, Priority, SlotCount, TaskKind,
    TaskName, TaskPayload, WorkerDescriptor, WorkerId, WorkerKind,
};
use robust_sinkhorn_queue::{QueueError, QueueResult};
use tokio::net::TcpListener;
use tokio::task::{JoinError, JoinSet};
use tokio::time::MissedTickBehavior;

const DEFAULT_DB_PATH: &str = "queue.db";
const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7331";
const DEFAULT_MAINTENANCE_INTERVAL_MS: u64 = 2_000;

type ConnectionResult = (SocketAddr, std::io::Result<()>);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Help,
    Version,
    Serve {
        db_path: PathBuf,
        listen_addr: SocketAddr,
        maintenance_interval: Duration,
    },
    Doctor {
        db_path: PathBuf,
    },
    Demo {
        db_path: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    let command = match parse_command(env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("error: {error}\n");
            print_help();
            process::exit(2);
        }
    };

    if let Err(error) = execute(command).await {
        eprintln!("fatal: {error}");
        process::exit(1);
    }
}

async fn execute(command: Command) -> QueueResult<()> {
    match command {
        Command::Help => {
            print_help();
            Ok(())
        }
        Command::Version => {
            println!("robust-sinkhorn-queue {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Command::Serve {
            db_path,
            listen_addr,
            maintenance_interval,
        } => run_serve(db_path, listen_addr, maintenance_interval).await,
        Command::Doctor { db_path } => run_doctor(db_path).await,
        Command::Demo { db_path } => run_demo(db_path).await,
    }
}

fn parse_command<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args: Vec<String> = args.into_iter().map(Into::into).collect();

    if args.is_empty() {
        return Ok(Command::Help);
    }

    match args[0].as_str() {
        "help" | "--help" | "-h" => {
            reject_trailing_args(&args[1..], "help")?;
            Ok(Command::Help)
        }
        "version" | "--version" | "-V" => {
            reject_trailing_args(&args[1..], "version")?;
            Ok(Command::Version)
        }
        "serve" => parse_serve_options(&args[1..]),
        "doctor" => Ok(Command::Doctor {
            db_path: parse_db_option(&args[1..], "doctor")?,
        }),
        "demo" => Ok(Command::Demo {
            db_path: parse_db_option(&args[1..], "demo")?,
        }),
        unknown => Err(format!("unknown command '{unknown}'")),
    }
}

fn reject_trailing_args(args: &[String], command: &str) -> Result<(), String> {
    if args.is_empty() {
        Ok(())
    } else {
        Err(format!("command '{command}' does not accept arguments"))
    }
}

fn parse_db_option(args: &[String], command: &str) -> Result<PathBuf, String> {
    let mut db_path = PathBuf::from(DEFAULT_DB_PATH);
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--db" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--db requires a path".to_string())?;
                db_path = PathBuf::from(value);
                index += 2;
            }
            unknown => {
                return Err(format!(
                    "unknown option '{unknown}' for command '{command}'"
                ));
            }
        }
    }

    Ok(db_path)
}

fn parse_serve_options(args: &[String]) -> Result<Command, String> {
    let mut db_path = PathBuf::from(DEFAULT_DB_PATH);
    let mut listen_addr = parse_loopback_addr(DEFAULT_LISTEN_ADDR)?;
    let mut maintenance_interval = Duration::from_millis(DEFAULT_MAINTENANCE_INTERVAL_MS);
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--db" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--db requires a path".to_string())?;
                db_path = PathBuf::from(value);
                index += 2;
            }
            "--listen" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--listen requires an IP:port value".to_string())?;
                listen_addr = parse_loopback_addr(value)?;
                index += 2;
            }
            "--maintenance-interval-ms" => {
                let value = args.get(index + 1).ok_or_else(|| {
                    "--maintenance-interval-ms requires a positive integer".to_string()
                })?;
                let millis = value.parse::<u64>().map_err(|_| {
                    "--maintenance-interval-ms must be a positive integer".to_string()
                })?;
                if millis == 0 {
                    return Err("--maintenance-interval-ms must be greater than zero".into());
                }
                maintenance_interval = Duration::from_millis(millis);
                index += 2;
            }
            unknown => {
                return Err(format!("unknown option '{unknown}' for command 'serve'"));
            }
        }
    }

    Ok(Command::Serve {
        db_path,
        listen_addr,
        maintenance_interval,
    })
}

fn parse_loopback_addr(value: &str) -> Result<SocketAddr, String> {
    let address = value.parse::<SocketAddr>().map_err(|_| {
        "--listen must be a numeric loopback IP:port, e.g. 127.0.0.1:7331".to_string()
    })?;

    if !address.ip().is_loopback() {
        return Err(
            "--listen must use a loopback address; expose Bun/Cloudflare, not the queue daemon"
                .into(),
        );
    }
    if address.port() == 0 {
        return Err("--listen port must be greater than zero".into());
    }

    Ok(address)
}

async fn run_doctor(db_path: PathBuf) -> QueueResult<()> {
    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await?;

    println!("status   : ok");
    println!("version  : {}", env!("CARGO_PKG_VERSION"));
    println!("os       : {}", env::consts::OS);
    println!("arch     : {}", env::consts::ARCH);
    println!("database : {}", db_path.display());
    println!("schema   : ready");

    Ok(())
}

fn log_connection_result(result: Result<ConnectionResult, JoinError>) {
    match result {
        Ok((_peer, Ok(()))) => {}
        Ok((peer, Err(error))) => {
            eprintln!("local API connection error from {peer}: {error}");
        }
        Err(error) => {
            eprintln!("local API connection task join error: {error}");
        }
    }
}

async fn drain_connections(connections: &mut JoinSet<ConnectionResult>) {
    while let Some(result) = connections.join_next().await {
        log_connection_result(result);
    }
}

async fn run_serve(
    db_path: PathBuf,
    listen_addr: SocketAddr,
    maintenance_interval: Duration,
) -> QueueResult<()> {
    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await?;

    let listener = TcpListener::bind(listen_addr).await.map_err(|error| {
        QueueError::InvalidState(format!(
            "failed to bind local API at {listen_addr}: {error}"
        ))
    })?;
    let api_state = LocalApiState::new(queue.clone(), &db_path);

    println!("robust-sinkhorn-queue {}", env!("CARGO_PKG_VERSION"));
    println!("mode                 : serve");
    println!("database             : {}", db_path.display());
    println!(
        "maintenance interval : {} ms",
        maintenance_interval.as_millis()
    );
    println!("network API          : http://{listen_addr} (loopback only)");
    println!("health               : http://{listen_addr}/healthz");
    println!("readiness            : http://{listen_addr}/readyz");
    println!("status               : ready");
    println!("press Ctrl+C to stop");

    let mut ticker = tokio::time::interval(maintenance_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut connections: JoinSet<ConnectionResult> = JoinSet::new();

    loop {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                if let Err(error) = signal {
                    return Err(QueueError::InvalidState(format!(
                        "failed to listen for Ctrl+C: {error}"
                    )));
                }
                println!("shutdown requested");
                break;
            }
            _ = ticker.tick() => {
                let recovered = queue.recover_expired_leases().await?;
                if recovered > 0 {
                    println!("recovered expired leases: {recovered}");
                }
            }
            joined = connections.join_next(), if !connections.is_empty() => {
                if let Some(result) = joined {
                    log_connection_result(result);
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = accepted.map_err(|error| {
                    QueueError::InvalidState(format!("local API accept error: {error}"))
                })?;

                if !peer.ip().is_loopback() {
                    eprintln!("rejected non-loopback local API peer: {peer}");
                    continue;
                }

                let state = api_state.clone();
                connections.spawn(async move {
                    let result = serve_connection(stream, state).await;
                    (peer, result)
                });
            }
        }
    }

    drop(listener);
    let in_flight = connections.len();
    if in_flight > 0 {
        println!("draining accepted connections: {in_flight}");
    }
    drain_connections(&mut connections).await;

    println!("shutdown complete");
    Ok(())
}

async fn run_demo(db_path: PathBuf) -> QueueResult<()> {
    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let worker = WorkerDescriptor {
        worker_id: WorkerId::new("demo-gpu-01"),
        kind: WorkerKind::Gpu,
        capacity: SlotCount::new(1)?,
        available_slots: SlotCount::new(1)?,
    };

    let lease = LeaseDuration::new(Duration::from_secs(30))?;
    let epsilon = Epsilon::new(1.5)?;

    let task_id = queue
        .enqueue(EnqueueCommand {
            name: TaskName::new("demo-train-model"),
            kind: TaskKind::Gpu,
            payload: TaskPayload::new(r#"{"batch_size":32,"mode":"demo"}"#),
            priority: Priority::new(10),
            max_retries: MaxRetries::new(3)?,
        })
        .await?;

    println!("demo task enqueued: {:?}", task_id);

    let dispatcher_workers = vec![worker.clone()];
    let dispatcher = tokio::spawn(run_dispatcher_loop(
        queue.clone(),
        shutdown_rx.clone(),
        Duration::from_millis(100),
        epsilon,
        lease,
        move || {
            let workers = dispatcher_workers.clone();
            async move { workers }
        },
    ));

    let handler = Arc::new(|task: ClaimedTask| async move {
        println!("processing demo task: {:?}", task.id);
        tokio::time::sleep(Duration::from_millis(250)).await;
        Ok(())
    });

    let worker_handles = spawn_worker_slots(
        queue.clone(),
        worker,
        shutdown_rx.clone(),
        Duration::from_millis(50),
        lease,
        handler,
    );

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
    }

    println!("demo shutdown started");
    let _ = shutdown_tx.send(true);

    dispatcher
        .await
        .map_err(|error| QueueError::InvalidState(format!("dispatcher join error: {error}")))??;

    for handle in worker_handles {
        handle
            .await
            .map_err(|error| QueueError::InvalidState(format!("worker join error: {error}")))??;
    }

    println!("demo shutdown complete");
    Ok(())
}

fn print_help() {
    println!(
        "robust-sinkhorn-queue {version}\n\n\
Usage:\n  robust-sinkhorn-queue <command> [options]\n\n\
Commands:\n  serve    Run queue maintenance + localhost-only HTTP API\n  doctor   Validate runtime + database access and ensure the schema\n  demo     Run the isolated built-in queue/worker demonstration\n  version  Print the binary version\n  help     Print this help\n\n\
Serve options:\n  --db <path>                         Database path (default: queue.db)\n  --listen <loopback-ip:port>         Local API address (default: 127.0.0.1:7331)\n  --maintenance-interval-ms <number>  Maintenance cadence (default: 2000)\n\n\
Local API:\n  GET  /healthz\n  GET  /readyz\n  POST /v1/tasks       metadata in X-Task-* headers; body is opaque UTF-8 payload\n  GET  /v1/tasks/<id>\n\n\
Examples:\n  robust-sinkhorn-queue doctor --db ~/.task-queue/queue.db\n  robust-sinkhorn-queue serve --db ~/.task-queue/queue.db\n  robust-sinkhorn-queue serve --db ~/.task-queue/queue.db --listen 127.0.0.1:7331\n  robust-sinkhorn-queue demo --db ./demo.db",
        version = env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn default_addr() -> SocketAddr {
        DEFAULT_LISTEN_ADDR.parse().unwrap()
    }

    #[test]
    fn no_args_is_safe_help() {
        assert_eq!(parse_command(Vec::<String>::new()).unwrap(), Command::Help);
    }

    #[test]
    fn parses_serve_with_defaults() {
        assert_eq!(
            parse_command(["serve"]).unwrap(),
            Command::Serve {
                db_path: PathBuf::from(DEFAULT_DB_PATH),
                listen_addr: default_addr(),
                maintenance_interval: Duration::from_millis(DEFAULT_MAINTENANCE_INTERVAL_MS),
            }
        );
    }

    #[test]
    fn parses_serve_options() {
        assert_eq!(
            parse_command([
                "serve",
                "--db",
                "/tmp/custom.db",
                "--listen",
                "127.0.0.1:7444",
                "--maintenance-interval-ms",
                "750",
            ])
            .unwrap(),
            Command::Serve {
                db_path: PathBuf::from("/tmp/custom.db"),
                listen_addr: "127.0.0.1:7444".parse().unwrap(),
                maintenance_interval: Duration::from_millis(750),
            }
        );
    }

    #[test]
    fn serve_rejects_non_loopback_or_zero_port() {
        assert!(parse_command(["serve", "--listen", "0.0.0.0:7331"]).is_err());
        assert!(parse_command(["serve", "--listen", "192.168.1.10:7331"]).is_err());
        assert!(parse_command(["serve", "--listen", "127.0.0.1:0"]).is_err());
        assert!(parse_command(["serve", "--listen", "localhost:7331"]).is_err());
        assert!(parse_command(["serve", "--listen", "[::1]:7331"]).is_ok());
    }

    #[test]
    fn parses_doctor_and_demo_db_paths() {
        assert_eq!(
            parse_command(["doctor", "--db", "doctor.db"]).unwrap(),
            Command::Doctor {
                db_path: PathBuf::from("doctor.db"),
            }
        );
        assert_eq!(
            parse_command(["demo", "--db", "demo.db"]).unwrap(),
            Command::Demo {
                db_path: PathBuf::from("demo.db"),
            }
        );
    }

    #[test]
    fn rejects_invalid_cli_inputs() {
        assert!(parse_command(["unknown"]).is_err());
        assert!(parse_command(["serve", "--maintenance-interval-ms", "0"]).is_err());
        assert!(parse_command(["serve", "--maintenance-interval-ms", "abc"]).is_err());
        assert!(parse_command(["doctor", "--unknown"]).is_err());
        assert!(parse_command(["version", "extra"]).is_err());
    }

    #[tokio::test]
    async fn drain_connections_waits_for_every_accepted_task() {
        let completed = Arc::new(AtomicUsize::new(0));
        let mut connections: JoinSet<ConnectionResult> = JoinSet::new();

        for port in [40001, 40002] {
            let completed = completed.clone();
            connections.spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                completed.fetch_add(1, Ordering::SeqCst);
                (
                    SocketAddr::from(([127, 0, 0, 1], port)),
                    Ok::<(), std::io::Error>(()),
                )
            });
        }

        drain_connections(&mut connections).await;

        assert_eq!(completed.load(Ordering::SeqCst), 2);
        assert!(connections.is_empty());
    }
}
