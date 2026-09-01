use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::task_query::TaskQueryStore;
use crate::tokio_queue::AsyncRobustSinkhornQueue;
use crate::value::{LeaseGeneration, LeaseMutation, TaskId, WorkerId, WorkerKind};
use crate::worker_protocol::{WorkerRegistration, WorkerRegistry, WorkerSession};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_WORKER_CAPACITY: i64 = 1_000_000;

#[derive(Clone)]
pub struct WorkerApiState {
    queue: AsyncRobustSinkhornQueue,
    query: TaskQueryStore,
    registry: WorkerRegistry,
    task_lease: crate::value::LeaseDuration,
}

impl WorkerApiState {
    pub fn new(
        queue: AsyncRobustSinkhornQueue,
        db_path: impl Into<PathBuf>,
        registry: WorkerRegistry,
        task_lease: crate::value::LeaseDuration,
    ) -> Self {
        Self {
            queue,
            query: TaskQueryStore::new(db_path),
            registry,
            task_lease,
        }
    }
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct Response {
    status: u16,
    reason: &'static str,
    body: String,
}

impl Response {
    fn json(status: u16, reason: &'static str, body: String) -> Self {
        Self {
            status,
            reason,
            body,
        }
    }

    fn error(status: u16, reason: &'static str, message: &str) -> Self {
        Self::json(
            status,
            reason,
            format!("{{\"error\":\"{}\"}}", json_escape(message)),
        )
    }
}

#[derive(Debug)]
struct HttpError {
    status: u16,
    reason: &'static str,
    message: String,
}

impl HttpError {
    fn new(status: u16, reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            reason,
            message: message.into(),
        }
    }

    fn into_response(self) -> Response {
        Response::error(self.status, self.reason, &self.message)
    }
}

pub async fn serve_worker_connection(
    mut stream: TcpStream,
    state: WorkerApiState,
) -> io::Result<()> {
    let response = match read_request(&mut stream).await {
        Ok(request) => route(request, state).await,
        Err(error) => error.into_response(),
    };
    write_response(&mut stream, response).await
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, HttpError> {
    let mut buffer = Vec::with_capacity(2048);
    let header_end = loop {
        if let Some(position) = find_header_end(&buffer) {
            if position > MAX_HEADER_BYTES {
                return Err(HttpError::new(
                    431,
                    "Request Header Fields Too Large",
                    "worker API headers exceed limit",
                ));
            }
            break position;
        }

        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(HttpError::new(
                431,
                "Request Header Fields Too Large",
                "worker API headers exceed limit",
            ));
        }

        let mut chunk = [0u8; 2048];
        let count = timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| HttpError::new(408, "Request Timeout", "worker API header timeout"))?
            .map_err(|error| HttpError::new(400, "Bad Request", error.to_string()))?;
        if count == 0 {
            return Err(HttpError::new(
                400,
                "Bad Request",
                "connection closed before worker request headers completed",
            ));
        }
        buffer.extend_from_slice(&chunk[..count]);
    };

    let header_text = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| HttpError::new(400, "Bad Request", "worker API headers must be UTF-8"))?;
    let (method, path, headers) = parse_head(header_text)?;

    if headers.contains_key("transfer-encoding") {
        return Err(HttpError::new(
            501,
            "Not Implemented",
            "transfer-encoding is not supported by the worker API",
        ));
    }

    let content_length = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| HttpError::new(400, "Bad Request", "invalid content-length"))?,
        None => 0,
    };
    if content_length > MAX_BODY_BYTES {
        return Err(HttpError::new(
            413,
            "Payload Too Large",
            "worker API request body exceeds 8 KiB",
        ));
    }

    let body_start = header_end + 4;
    let mut body = if buffer.len() > body_start {
        buffer[body_start..].to_vec()
    } else {
        Vec::new()
    };
    body.truncate(content_length);
    while body.len() < content_length {
        let mut chunk = vec![0u8; (content_length - body.len()).min(4096)];
        let count = timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| HttpError::new(408, "Request Timeout", "worker API body timeout"))?
            .map_err(|error| HttpError::new(400, "Bad Request", error.to_string()))?;
        if count == 0 {
            return Err(HttpError::new(
                400,
                "Bad Request",
                "connection closed before worker request body completed",
            ));
        }
        body.extend_from_slice(&chunk[..count]);
    }

    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn parse_head(header_text: &str) -> Result<(String, String, HashMap<String, String>), HttpError> {
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing method"))?;
    let path = parts
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing path"))?;
    let version = parts
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing HTTP version"))?;
    if parts.next().is_some() {
        return Err(HttpError::new(400, "Bad Request", "invalid request line"));
    }
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(HttpError::new(
            505,
            "HTTP Version Not Supported",
            "only HTTP/1.0 and HTTP/1.1 are supported",
        ));
    }
    if !path.starts_with('/') || path.contains(' ') {
        return Err(HttpError::new(400, "Bad Request", "invalid request path"));
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| HttpError::new(400, "Bad Request", "malformed header"))?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(HttpError::new(400, "Bad Request", "empty header name"));
        }
        if name == "content-length" && headers.contains_key(&name) {
            return Err(HttpError::new(
                400,
                "Bad Request",
                "duplicate content-length header",
            ));
        }
        headers.insert(name, value.trim().to_string());
    }

    Ok((method.to_string(), path.to_string(), headers))
}

async fn route(request: Request, state: WorkerApiState) -> Response {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/healthz") => Response::json(
            200,
            "OK",
            format!(
                "{{\"status\":\"ok\",\"version\":\"{}\"}}",
                env!("CARGO_PKG_VERSION")
            ),
        ),
        ("GET", "/readyz") => route_ready(state).await,
        ("POST", "/v1/register") => route_register(request, state).await,
        ("POST", "/v1/session/heartbeat") => route_session_heartbeat(request, state),
        ("POST", "/v1/claim") => route_claim(request, state).await,
        ("POST", "/v1/task/heartbeat") => route_task_heartbeat(request, state).await,
        ("POST", "/v1/task/complete") => route_task_complete(request, state).await,
        ("POST", "/v1/task/fail") => route_task_fail(request, state).await,
        _ => Response::error(404, "Not Found", "worker route not found"),
    }
}

async fn route_ready(state: WorkerApiState) -> Response {
    let query = state.query.clone();
    match tokio::task::spawn_blocking(move || query.ping()).await {
        Ok(Ok(())) => Response::json(200, "OK", "{\"status\":\"ready\"}".into()),
        Ok(Err(error)) => Response::error(503, "Service Unavailable", &error.to_string()),
        Err(error) => Response::error(503, "Service Unavailable", &error.to_string()),
    }
}

async fn route_register(request: Request, state: WorkerApiState) -> Response {
    if let Err(response) = require_empty_body(&request) {
        return response;
    }
    let worker_id = match required_header(&request.headers, "x-worker-id") {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let worker_type = match required_header(&request.headers, "x-worker-type") {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    if let Err(message) = validate_identifier(&worker_id, 128, "x-worker-id") {
        return Response::error(400, "Bad Request", &message);
    }
    if let Err(message) = validate_identifier(&worker_type, 64, "x-worker-type") {
        return Response::error(400, "Bad Request", &message);
    }
    let capacity = match parse_bounded_i64_header(
        &request.headers,
        "x-worker-capacity",
        1,
        MAX_WORKER_CAPACITY,
    ) {
        Ok(value) => value,
        Err(response) => return response,
    };

    match state
        .registry
        .register(worker_id, WorkerKind::from_db(&worker_type), capacity)
    {
        Ok(registration) => Response::json(
            201,
            "Created",
            registration_json(
                &registration,
                state.registry.ttl(),
                state.task_lease.value(),
            ),
        ),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
    }
}

fn route_session_heartbeat(request: Request, state: WorkerApiState) -> Response {
    if let Err(response) = require_empty_body(&request) {
        return response;
    }
    match authenticate(&request.headers, &state.registry) {
        Ok(session) => Response::json(
            200,
            "OK",
            format!(
                "{{\"status\":\"alive\",\"worker_id\":\"{}\",\"session_id\":\"{}\"}}",
                json_escape(&session.worker_id),
                json_escape(&session.session_id)
            ),
        ),
        Err(response) => response,
    }
}

async fn route_claim(request: Request, state: WorkerApiState) -> Response {
    if let Err(response) = require_empty_body(&request) {
        return response;
    }
    let session = match authenticate(&request.headers, &state.registry) {
        Ok(session) => session,
        Err(response) => return response,
    };

    match state
        .queue
        .claim_task(WorkerId::new(session.session_id))
        .await
    {
        Ok(Some(task)) => Response::json(
            200,
            "OK",
            format!(
                concat!(
                    "{{",
                    "\"task_id\":{},",
                    "\"task_name\":\"{}\",",
                    "\"task_type\":\"{}\",",
                    "\"payload\":\"{}\",",
                    "\"retry_count\":{},",
                    "\"max_retries\":{},",
                    "\"lease_generation\":{},",
                    "\"lease_ms\":{}",
                    "}}"
                ),
                task.id.value(),
                json_escape(task.task_name.as_str()),
                json_escape(&task.task_kind.to_db()),
                json_escape(task.payload.as_str()),
                task.retry_count.value(),
                task.max_retries.value(),
                task.lease_generation.value(),
                state.task_lease.value().as_millis(),
            ),
        ),
        Ok(None) => Response::json(204, "No Content", String::new()),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
    }
}

async fn route_task_heartbeat(request: Request, state: WorkerApiState) -> Response {
    if let Err(response) = require_empty_body(&request) {
        return response;
    }
    let session = match authenticate(&request.headers, &state.registry) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let (task_id, generation) = match task_fence_headers(&request.headers) {
        Ok(value) => value,
        Err(response) => return response,
    };

    match state
        .queue
        .heartbeat(
            TaskId::new(task_id),
            WorkerId::new(session.session_id),
            LeaseGeneration::new(generation),
            state.task_lease,
        )
        .await
    {
        Ok(LeaseMutation::Applied) => {
            Response::json(200, "OK", "{\"transition\":\"applied\"}".into())
        }
        Ok(LeaseMutation::Stale) => Response::error(409, "Conflict", "task lease is stale"),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
    }
}

async fn route_task_complete(request: Request, state: WorkerApiState) -> Response {
    if let Err(response) = require_empty_body(&request) {
        return response;
    }
    let session = match authenticate(&request.headers, &state.registry) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let (task_id, generation) = match task_fence_headers(&request.headers) {
        Ok(value) => value,
        Err(response) => return response,
    };

    match state
        .queue
        .complete_task(
            TaskId::new(task_id),
            WorkerId::new(session.session_id),
            LeaseGeneration::new(generation),
        )
        .await
    {
        Ok(LeaseMutation::Applied) => {
            Response::json(200, "OK", "{\"transition\":\"applied\"}".into())
        }
        Ok(LeaseMutation::Stale) => Response::error(409, "Conflict", "task lease is stale"),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
    }
}

async fn route_task_fail(request: Request, state: WorkerApiState) -> Response {
    if let Err(response) = require_empty_body(&request) {
        return response;
    }
    let session = match authenticate(&request.headers, &state.registry) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let (task_id, generation) = match task_fence_headers(&request.headers) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let error_code = match required_header(&request.headers, "x-worker-error-code") {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Err(message) = validate_identifier(error_code, 128, "x-worker-error-code") {
        return Response::error(400, "Bad Request", &message);
    }
    let stored_error = format!("worker_error:{error_code}");

    match state
        .queue
        .fail_task(
            TaskId::new(task_id),
            WorkerId::new(session.session_id),
            LeaseGeneration::new(generation),
            &stored_error,
        )
        .await
    {
        Ok(LeaseMutation::Applied) => {
            Response::json(200, "OK", "{\"transition\":\"applied\"}".into())
        }
        Ok(LeaseMutation::Stale) => Response::error(409, "Conflict", "task lease is stale"),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
    }
}

fn authenticate(
    headers: &HashMap<String, String>,
    registry: &WorkerRegistry,
) -> Result<WorkerSession, Response> {
    let session_id = required_header(headers, "x-worker-session")?;
    let session_token = required_header(headers, "x-worker-token")?;
    if session_id.len() != 32 || !session_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Response::error(
            401,
            "Unauthorized",
            "invalid worker session credentials",
        ));
    }
    if session_token.len() != 64 || !session_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Response::error(
            401,
            "Unauthorized",
            "invalid worker session credentials",
        ));
    }

    match registry.authenticate_and_touch(session_id, session_token) {
        Ok(Some(session)) => Ok(session),
        Ok(None) => Err(Response::error(
            401,
            "Unauthorized",
            "invalid or expired worker session",
        )),
        Err(error) => Err(Response::error(
            500,
            "Internal Server Error",
            &error.to_string(),
        )),
    }
}

fn task_fence_headers(headers: &HashMap<String, String>) -> Result<(i64, i64), Response> {
    let task_id = parse_bounded_i64_header(headers, "x-task-id", 1, i64::MAX)?;
    let generation = parse_bounded_i64_header(headers, "x-lease-generation", 1, i64::MAX)?;
    Ok((task_id, generation))
}

fn require_empty_body(request: &Request) -> Result<(), Response> {
    if request.body.is_empty() {
        Ok(())
    } else {
        Err(Response::error(
            400,
            "Bad Request",
            "worker control requests must not contain a body",
        ))
    }
}

fn required_header<'a>(
    headers: &'a HashMap<String, String>,
    name: &str,
) -> Result<&'a str, Response> {
    headers
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Response::error(400, "Bad Request", &format!("missing {name} header")))
}

fn parse_bounded_i64_header(
    headers: &HashMap<String, String>,
    name: &str,
    min: i64,
    max: i64,
) -> Result<i64, Response> {
    let raw = required_header(headers, name)?;
    match raw.parse::<i64>() {
        Ok(value) if (min..=max).contains(&value) => Ok(value),
        _ => Err(Response::error(
            400,
            "Bad Request",
            &format!("{name} must be an integer between {min} and {max}"),
        )),
    }
}

fn validate_identifier(value: &str, max_len: usize, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > max_len {
        return Err(format!("{field} length must be between 1 and {max_len}"));
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
    }) {
        return Err(format!(
            "{field} may contain only ASCII alphanumeric characters and . _ - : /"
        ));
    }
    Ok(())
}

fn registration_json(registration: &WorkerRegistration, ttl: Duration, lease: Duration) -> String {
    format!(
        concat!(
            "{{",
            "\"worker_id\":\"{}\",",
            "\"worker_type\":\"{}\",",
            "\"capacity\":{},",
            "\"session_id\":\"{}\",",
            "\"session_token\":\"{}\",",
            "\"session_ttl_ms\":{},",
            "\"task_lease_ms\":{}",
            "}}"
        ),
        json_escape(&registration.session.worker_id),
        json_escape(&registration.session.kind.to_db()),
        registration.session.capacity,
        json_escape(&registration.session.session_id),
        json_escape(&registration.session_token),
        ttl.as_millis(),
        lease.as_millis(),
    )
}

fn json_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c < '\u{20}' => {
                use std::fmt::Write;
                let _ = write!(output, "\\u{:04x}", c as u32);
            }
            c => output.push(c),
        }
    }
    output
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let bytes = response.body.as_bytes();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        response.status,
        response.reason,
        bytes.len()
    );

    timeout(IO_TIMEOUT, async {
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(bytes).await?;
        stream.shutdown().await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "worker response write timeout"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{
        Epsilon, LeaseDuration, MaxRetries, Priority, TaskKind, TaskName, TaskPayload,
    };
    use crate::worker_protocol::WorkerCoordinator;

    fn request(method: &str, path: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: HashMap::new(),
            body: Vec::new(),
        }
    }

    fn credentials(request: &mut Request, registration: &WorkerRegistration) {
        request.headers.insert(
            "x-worker-session".into(),
            registration.session.session_id.clone(),
        );
        request
            .headers
            .insert("x-worker-token".into(), registration.session_token.clone());
    }

    #[tokio::test]
    async fn worker_claim_is_fenced_and_payload_is_available_only_after_assignment() {
        let db_path =
            std::env::temp_dir().join(format!("worker_api_claim_{}.db", rand::random::<u64>()));
        let queue = AsyncRobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().await.unwrap();
        queue
            .enqueue(crate::value::EnqueueCommand {
                name: TaskName::new("document.process"),
                kind: TaskKind::Cpu,
                payload: TaskPayload::new("secret-payload"),
                priority: Priority::new(5),
                max_retries: MaxRetries::new(3).unwrap(),
            })
            .await
            .unwrap();

        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let lease = LeaseDuration::new(Duration::from_secs(30)).unwrap();
        let registration = registry.register("worker-a", WorkerKind::Cpu, 1).unwrap();
        let coordinator = WorkerCoordinator::new(
            &db_path,
            registry.clone(),
            Epsilon::new(1.5).unwrap(),
            lease,
        );
        assert_eq!(coordinator.dispatch_available().await.unwrap().len(), 1);
        let state = WorkerApiState::new(queue, &db_path, registry, lease);

        let mut claim = request("POST", "/v1/claim");
        credentials(&mut claim, &registration);
        let claimed = route(claim, state.clone()).await;
        assert_eq!(claimed.status, 200);
        assert!(claimed.body.contains("\"task_id\":1"));
        assert!(claimed.body.contains("secret-payload"));
        assert!(claimed.body.contains("\"lease_generation\":1"));

        let mut stale_complete = request("POST", "/v1/task/complete");
        credentials(&mut stale_complete, &registration);
        stale_complete
            .headers
            .insert("x-task-id".into(), "1".into());
        stale_complete
            .headers
            .insert("x-lease-generation".into(), "2".into());
        assert_eq!(route(stale_complete, state.clone()).await.status, 409);

        let mut complete = request("POST", "/v1/task/complete");
        credentials(&mut complete, &registration);
        complete.headers.insert("x-task-id".into(), "1".into());
        complete
            .headers
            .insert("x-lease-generation".into(), "1".into());
        assert_eq!(route(complete, state).await.status, 200);

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn wrong_worker_token_cannot_claim() {
        let db_path =
            std::env::temp_dir().join(format!("worker_api_auth_{}.db", rand::random::<u64>()));
        let queue = AsyncRobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().await.unwrap();
        let registry = WorkerRegistry::new(Duration::from_secs(60)).unwrap();
        let lease = LeaseDuration::new(Duration::from_secs(30)).unwrap();
        let registration = registry.register("worker-a", WorkerKind::Cpu, 1).unwrap();
        let state = WorkerApiState::new(queue, &db_path, registry, lease);

        let mut claim = request("POST", "/v1/claim");
        claim
            .headers
            .insert("x-worker-session".into(), registration.session.session_id);
        claim
            .headers
            .insert("x-worker-token".into(), "0".repeat(64));
        assert_eq!(route(claim, state).await.status, 401);

        let _ = std::fs::remove_file(&db_path);
    }
}
