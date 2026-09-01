use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process;
use std::time::Duration;

use robust_sinkhorn_queue::tokio_queue::AsyncRobustSinkhornQueue;
use robust_sinkhorn_queue::value::{Epsilon, LeaseDuration};
use robust_sinkhorn_queue::worker_api::{serve_worker_connection, WorkerApiState};
use robust_sinkhorn_queue::worker_protocol::{WorkerCoordinator, WorkerRegistry};
use robust_sinkhorn_queue::{QueueError, QueueResult};
use tokio::net::TcpListener;
use tokio::task::{JoinError, JoinSet};
use tokio::time::MissedTickBehavior;

const DEFAULT_DB_PATH: &str = "queue.db";
const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7332";
const DEFAULT_DISPATCH_INTERVAL_MS: u64 = 250;
const DEFAULT_SESSION_TTL_MS: u64 = 60_000;
const DEFAULT_TASK_LEASE_MS: u64 = 30_000;

type ConnectionResult = (SocketAddr, std::io::Result<()>);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Help,
    Version,
    Serve {
        db_path: PathBuf,
        listen_addr: SocketAddr,
        dispatch_interval: Duration,
        session_ttl: Duration,
        task_lease: Duration,
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
            println!("robust-sinkhorn-worker {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Command::Serve {
            db_path,
            listen_addr,
            dispatch_interval,
            session_ttl,
            task_lease,
        } => {
            run_serve(
                db_path,
                listen_addr,
                dispatch_interval,
                session_ttl,
                task_lease,
            )
            .await
        }
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
            if args.len() != 1 {
                return Err("help does not accept arguments".into());
            }
            Ok(Command::Help)
        }
        "version" | "--version" | "-V" => {
            if args.len() != 1 {
                return Err("version does not accept arguments".into());
            }
            Ok(Command::Version)
        }
        "serve" => parse_serve_options(&args[1..]),
        unknown => Err(format!("unknown command '{unknown}'")),
    }
}

fn parse_serve_options(args: &[String]) -> Result<Command, String> {
    let mut db_path = PathBuf::from(DEFAULT_DB_PATH);
    let mut listen_addr = parse_loopback_addr(DEFAULT_LISTEN_ADDR)?;
    let mut dispatch_interval = Duration::from_millis(DEFAULT_DISPATCH_INTERVAL_MS);
    let mut session_ttl = Duration::from_millis(DEFAULT_SESSION_TTL_MS);
    let mut task_lease = Duration::from_millis(DEFAULT_TASK_LEASE_MS);
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
            "--dispatch-interval-ms" => {
                dispatch_interval = Duration::from_millis(parse_positive_u64(
                    args,
                    index,
                    "--dispatch-interval-ms",
                )?);
                index += 2;
            }
            "--session-ttl-ms" => {
                session_ttl = Duration::from_millis(parse_positive_u64(
                    args,
                    index,
                    "--session-ttl-ms",
                )?);
                index += 2;
            }
            "--task-lease-ms" => {
                task_lease = Duration::from_millis(parse_positive_u64(
                    args,
                    index,
                    "--task-lease-ms",
                )?);
                index += 2;
            }
            unknown => {
                return Err(format!("unknown option '{unknown}' for command 'serve'"));
            }
        }
    }

    if session_ttl < task_lease {
        return Err("--session-ttl-ms must be greater than or equal to --task-lease-ms".into());
    }

    Ok(Command::Serve {
        db_path,
        listen_addr,
        dispatch_interval,
        session_ttl,
        task_lease,
    })
}

fn parse_positive_u64(args: &[String], index: usize, option: &str) -> Result<u64, String> {
    let raw = args
        .get(index + 1)
        .ok_or_else(|| format!("{option} requires a positive integer"))?;
    let value = raw
        .parse::<u64>()
        .map_err(|_| format!("{option} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{option} must be greater than zero"));
    }
    Ok(value)
}

fn parse_loopback_addr(value: &str) -> Result<SocketAddr, String> {
    let address = value.parse::<SocketAddr>().map_err(|_| {
        "--listen must be a numeric loopback IP:port, e.g. 127.0.0.1:7332".to_string()
    })?;
    if !address.ip().is_loopback() {
        return Err("--listen must use a loopback address; worker payloads are local-only".into());
    }
    if address.port() == 0 {
        return Err("--listen port must be greater than zero".into());
    }
    Ok(address)
}

async fn run_serve(
    db_path: PathBuf,
    listen_addr: SocketAddr,
    dispatch_interval: Duration,
    session_ttl: Duration,
    task_lease_duration: Duration,
) -> QueueResult<()> {
    let queue = AsyncRobustSinkhornQueue::new(&db_path);
    queue.ensure_schema().await?;
    let registry = WorkerRegistry::new(session_ttl)?;
    let task_lease = LeaseDuration::new(task_lease_duration)?;
    let coordinator = WorkerCoordinator::new(
        &db_path,
        registry.clone(),
        Epsilon::new(1.5)?,
        task_lease,
    );
    let api_state = WorkerApiState::new(queue.clone(), &db_path, registry, task_lease);

    let listener = TcpListener::bind(listen_addr).await.map_err(|error| {
        QueueError::InvalidState(format!(
            "failed to bind worker API at {listen_addr}: {error}"
        ))
    })?;

    println!("robust-sinkhorn-worker {}", env!("CARGO_PKG_VERSION"));
    println!("mode              : serve");
    println!("database          : {}", db_path.display());
    println!("worker API        : http://{listen_addr} (loopback only)");
    println!("dispatch interval : {} ms", dispatch_interval.as_millis());
    println!("session ttl       : {} ms", session_ttl.as_millis());
    println!("task lease        : {} ms", task_lease_duration.as_millis());
    println!("status            : ready");
    println!("press Ctrl+C to stop");

    let mut ticker = tokio::time::interval(dispatch_interval);
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
                    println!("recovered expired worker leases: {recovered}");
                }
                let assignments = coordinator.dispatch_available().await?;
                if !assignments.is_empty() {
                    println!("strict worker assignments: {}", assignments.len());
                }
            }
            joined = connections.join_next(), if !connections.is_empty() => {
                if let Some(result) = joined {
                    log_connection_result(result);
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = accepted.map_err(|error| {
                    QueueError::InvalidState(format!("worker API accept error: {error}"))
                })?;
                if !peer.ip().is_loopback() {
                    eprintln!("rejected non-loopback worker API peer: {peer}");
                    continue;
                }
                let state = api_state.clone();
                connections.spawn(async move {
                    let result = serve_worker_connection(stream, state).await;
                    (peer, result)
                });
            }
        }
    }

    drop(listener);
    let in_flight = connections.len();
    if in_flight > 0 {
        println!("draining accepted worker connections: {in_flight}");
    }
    while let Some(result) = connections.join_next().await {
        log_connection_result(result);
    }
    println!("shutdown complete");
    Ok(())
}

fn log_connection_result(result: Result<ConnectionResult, JoinError>) {
    match result {
        Ok((_peer, Ok(()))) => {}
        Ok((peer, Err(error))) => eprintln!("worker API connection error from {peer}: {error}"),
        Err(error) => eprintln!("worker API connection task join error: {error}"),
    }
}

fn print_help() {
    println!(
        "robust-sinkhorn-worker {version}\n\n\
Usage:\n  robust-sinkhorn-worker <command> [options]\n\n\
Commands:\n  serve    Run the loopback-only worker broker\n  version  Print the binary version\n  help     Print this help\n\n\
Serve options:\n  --db <path>                    Queue database path (default: queue.db)\n  --listen <loopback-ip:port>    Worker API address (default: 127.0.0.1:7332)\n  --dispatch-interval-ms <n>     Strict dispatch cadence (default: 250)\n  --session-ttl-ms <n>           Worker session TTL (default: 60000)\n  --task-lease-ms <n>            Fenced task lease (default: 30000)\n\n\
Worker API:\n  GET  /healthz\n  GET  /readyz\n  POST /v1/register\n  POST /v1/session/heartbeat\n  POST /v1/claim\n  POST /v1/task/heartbeat\n  POST /v1/task/complete\n  POST /v1/task/fail\n\n\
The worker API is a local data-plane. Do not expose port 7332 through Bun, Cloudflare, or router NAT.",
        version = env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_addr() -> SocketAddr {
        DEFAULT_LISTEN_ADDR.parse().unwrap()
    }

    #[test]
    fn no_args_is_safe_help() {
        assert_eq!(parse_command(Vec::<String>::new()).unwrap(), Command::Help);
    }

    #[test]
    fn parses_reference_defaults() {
        assert_eq!(
            parse_command(["serve"]).unwrap(),
            Command::Serve {
                db_path: PathBuf::from(DEFAULT_DB_PATH),
                listen_addr: default_addr(),
                dispatch_interval: Duration::from_millis(DEFAULT_DISPATCH_INTERVAL_MS),
                session_ttl: Duration::from_millis(DEFAULT_SESSION_TTL_MS),
                task_lease: Duration::from_millis(DEFAULT_TASK_LEASE_MS),
            }
        );
    }

    #[test]
    fn parses_overrides_without_changing_engine_limits() {
        assert_eq!(
            parse_command([
                "serve",
                "--db",
                "/tmp/worker.db",
                "--listen",
                "127.0.0.1:7445",
                "--dispatch-interval-ms",
                "100",
                "--session-ttl-ms",
                "90000",
                "--task-lease-ms",
                "45000",
            ])
            .unwrap(),
            Command::Serve {
                db_path: PathBuf::from("/tmp/worker.db"),
                listen_addr: "127.0.0.1:7445".parse().unwrap(),
                dispatch_interval: Duration::from_millis(100),
                session_ttl: Duration::from_millis(90000),
                task_lease: Duration::from_millis(45000),
            }
        );
    }

    #[test]
    fn worker_listener_and_timing_fail_closed() {
        assert!(parse_command(["serve", "--listen", "0.0.0.0:7332"]).is_err());
        assert!(parse_command(["serve", "--listen", "127.0.0.1:0"]).is_err());
        assert!(parse_command(["serve", "--dispatch-interval-ms", "0"]).is_err());
        assert!(parse_command(["serve", "--session-ttl-ms", "1000", "--task-lease-ms", "2000"]).is_err());
    }
}
