use std::collections::BTreeSet;
use std::io;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::worker_api::{serve_worker_connection, WorkerApiState};
use crate::worker_protocol::WorkerRegistry;

const PEEK_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PEEK_BYTES: usize = 1024;

pub async fn serve_worker_connection_with_provider_snapshot(
    mut stream: TcpStream,
    state: WorkerApiState,
    registry: WorkerRegistry,
) -> io::Result<()> {
    let mut peek = [0u8; MAX_PEEK_BYTES];
    let count = timeout(PEEK_TIMEOUT, stream.peek(&mut peek))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "worker API request peek timeout"))??;

    if is_provider_snapshot_request(&peek[..count]) {
        let body = provider_snapshot_json(&registry)
            .map_err(|error| io::Error::other(format!("provider snapshot failed: {error}")))?;
        let response = format!(
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: application/json; charset=utf-8\r\n",
                "Content-Length: {}\r\n",
                "Connection: close\r\n",
                "Cache-Control: no-store\r\n",
                "\r\n",
                "{}"
            ),
            body.len(),
            body,
        );
        stream.write_all(response.as_bytes()).await?;
        stream.shutdown().await?;
        return Ok(());
    }

    serve_worker_connection(stream, state).await
}

fn is_provider_snapshot_request(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GET /v1/providers HTTP/1.1\r\n")
        || bytes.starts_with(b"GET /v1/providers HTTP/1.0\r\n")
}

fn provider_snapshot_json(registry: &WorkerRegistry) -> crate::QueueResult<String> {
    let sessions = registry.active_sessions()?;
    let mut active_task_names = BTreeSet::new();
    let mut worker_types = BTreeSet::new();

    for session in sessions {
        worker_types.insert(session.kind.to_db());
        active_task_names.extend(session.task_names);
    }

    let task_names = active_task_names
        .into_iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(",");
    let worker_types = worker_types
        .into_iter()
        .map(|kind| format!("\"{kind}\""))
        .collect::<Vec<_>>()
        .join(",");

    Ok(format!(
        "{{\"schema_version\":1,\"active_task_names\":[{task_names}],\"worker_types\":[{worker_types}]}}\n"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::WorkerKind;

    #[test]
    fn provider_snapshot_is_deterministic_and_contains_no_session_secret() {
        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let first = registry
            .register(
                "worker-b",
                WorkerKind::from_db("vector"),
                1,
                vec!["vector.dot".into()],
            )
            .unwrap();
        let second = registry
            .register(
                "worker-a",
                WorkerKind::from_db("cpu"),
                2,
                vec!["hash.compute".into(), "document.process".into()],
            )
            .unwrap();

        let json = provider_snapshot_json(&registry).unwrap();
        assert_eq!(
            json,
            "{\"schema_version\":1,\"active_task_names\":[\"document.process\",\"hash.compute\",\"vector.dot\"],\"worker_types\":[\"cpu\",\"vector\"]}\n"
        );
        assert!(!json.contains(&first.session.session_id));
        assert!(!json.contains(&first.session_token));
        assert!(!json.contains(&second.session.session_id));
        assert!(!json.contains(&second.session_token));
    }

    #[test]
    fn only_exact_provider_snapshot_route_is_intercepted() {
        assert!(is_provider_snapshot_request(b"GET /v1/providers HTTP/1.1\r\nHost: x\r\n\r\n"));
        assert!(!is_provider_snapshot_request(b"POST /v1/providers HTTP/1.1\r\n\r\n"));
        assert!(!is_provider_snapshot_request(b"GET /v1/providers/extra HTTP/1.1\r\n\r\n"));
    }
}
