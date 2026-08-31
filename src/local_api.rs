use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::task_query::{TaskQueryStore, TaskSnapshot};
use crate::tokio_queue::AsyncRobustSinkhornQueue;
use crate::value::{EnqueueCommand, MaxRetries, Priority, TaskKind, TaskName, TaskPayload};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct LocalApiState {
    queue: AsyncRobustSinkhornQueue,
    query: TaskQueryStore,
}

impl LocalApiState {
    pub fn new(queue: AsyncRobustSinkhornQueue, db_path: impl Into<PathBuf>) -> Self {
        Self {
            queue,
            query: TaskQueryStore::new(db_path),
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

pub async fn serve_connection(mut stream: TcpStream, state: LocalApiState) -> io::Result<()> {
    let response = match read_request(&mut stream).await {
        Ok(request) => route(request, state).await,
        Err(error) => error.into_response(),
    };

    write_response(&mut stream, response).await
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, HttpError> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(position) = find_header_end(&buffer) {
            break position;
        }

        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(HttpError::new(
                431,
                "Request Header Fields Too Large",
                "request headers exceed local API limit",
            ));
        }

        let mut chunk = [0u8; 4096];
        let count = timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| HttpError::new(408, "Request Timeout", "request header timeout"))?
            .map_err(|error| HttpError::new(400, "Bad Request", error.to_string()))?;

        if count == 0 {
            return Err(HttpError::new(
                400,
                "Bad Request",
                "connection closed before request headers completed",
            ));
        }

        buffer.extend_from_slice(&chunk[..count]);
    };

    let header_bytes = &buffer[..header_end];
    let header_text = std::str::from_utf8(header_bytes)
        .map_err(|_| HttpError::new(400, "Bad Request", "request headers must be UTF-8"))?;

    let (method, path, headers) = parse_head(header_text)?;

    if headers.contains_key("transfer-encoding") {
        return Err(HttpError::new(
            501,
            "Not Implemented",
            "transfer-encoding is not supported by the local API",
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
            "request body exceeds 1 MiB local API limit",
        ));
    }

    let body_start = header_end + 4;
    let mut body = if buffer.len() > body_start {
        buffer[body_start..].to_vec()
    } else {
        Vec::new()
    };

    if body.len() > content_length {
        body.truncate(content_length);
    }

    while body.len() < content_length {
        let remaining = content_length - body.len();
        let mut chunk = vec![0u8; remaining.min(8192)];
        let count = timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| HttpError::new(408, "Request Timeout", "request body timeout"))?
            .map_err(|error| HttpError::new(400, "Bad Request", error.to_string()))?;

        if count == 0 {
            return Err(HttpError::new(
                400,
                "Bad Request",
                "connection closed before request body completed",
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

    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing method"))?;
    let path = request_parts
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing path"))?;
    let version = request_parts
        .next()
        .ok_or_else(|| HttpError::new(400, "Bad Request", "missing HTTP version"))?;

    if request_parts.next().is_some() {
        return Err(HttpError::new(
            400,
            "Bad Request",
            "invalid request line",
        ));
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
        let value = value.trim().to_string();

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

        headers.insert(name, value);
    }

    Ok((method.to_string(), path.to_string(), headers))
}

async fn route(request: Request, state: LocalApiState) -> Response {
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
        ("POST", "/v1/tasks") => route_enqueue(request, state).await,
        _ if request.method == "GET" && request.path.starts_with("/v1/tasks/") => {
            route_get_task(request.path, state).await
        }
        _ => Response::error(404, "Not Found", "route not found"),
    }
}

async fn route_ready(state: LocalApiState) -> Response {
    let query = state.query.clone();
    match tokio::task::spawn_blocking(move || query.ping()).await {
        Ok(Ok(())) => Response::json(200, "OK", "{\"status\":\"ready\"}".into()),
        Ok(Err(error)) => Response::error(503, "Service Unavailable", &error.to_string()),
        Err(error) => Response::error(503, "Service Unavailable", &error.to_string()),
    }
}

async fn route_enqueue(request: Request, state: LocalApiState) -> Response {
    let task_name = match required_header(&request.headers, "x-task-name") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let task_type = match required_header(&request.headers, "x-task-type") {
        Ok(value) => value,
        Err(response) => return response,
    };

    if let Err(message) = validate_identifier(task_name, 128, "x-task-name") {
        return Response::error(400, "Bad Request", &message);
    }
    if let Err(message) = validate_identifier(task_type, 64, "x-task-type") {
        return Response::error(400, "Bad Request", &message);
    }

    let priority = match parse_i64_header(&request.headers, "x-task-priority", 0) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let max_retries = match parse_i64_header(&request.headers, "x-task-max-retries", 3) {
        Ok(value) if (0..=100).contains(&value) => value,
        Ok(_) => {
            return Response::error(
                400,
                "Bad Request",
                "x-task-max-retries must be between 0 and 100",
            )
        }
        Err(response) => return response,
    };

    let payload = match String::from_utf8(request.body) {
        Ok(value) => value,
        Err(_) => {
            return Response::error(
                400,
                "Bad Request",
                "task payload body must be valid UTF-8",
            )
        }
    };

    let kind = TaskKind::from_db(task_type);
    let max_retries = match MaxRetries::new(max_retries) {
        Ok(value) => value,
        Err(error) => return Response::error(400, "Bad Request", &error.to_string()),
    };

    match state
        .queue
        .enqueue(EnqueueCommand {
            name: TaskName::new(task_name),
            kind,
            payload: TaskPayload::new(payload),
            priority: Priority::new(priority),
            max_retries,
        })
        .await
    {
        Ok(task_id) => Response::json(
            202,
            "Accepted",
            format!(
                "{{\"task_id\":{},\"status\":\"PENDING\"}}",
                task_id.value()
            ),
        ),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
    }
}

async fn route_get_task(path: String, state: LocalApiState) -> Response {
    let id_text = match path.strip_prefix("/v1/tasks/") {
        Some(value) if !value.is_empty() && !value.contains('/') => value,
        _ => return Response::error(404, "Not Found", "task route not found"),
    };

    let task_id = match id_text.parse::<i64>() {
        Ok(value) if value > 0 => value,
        _ => return Response::error(400, "Bad Request", "task id must be a positive integer"),
    };

    let query = state.query.clone();
    match tokio::task::spawn_blocking(move || query.get_task(task_id)).await {
        Ok(Ok(Some(snapshot))) => Response::json(200, "OK", snapshot_json(&snapshot)),
        Ok(Ok(None)) => Response::error(404, "Not Found", "task not found"),
        Ok(Err(error)) => Response::error(500, "Internal Server Error", &error.to_string()),
        Err(error) => Response::error(500, "Internal Server Error", &error.to_string()),
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

fn parse_i64_header(
    headers: &HashMap<String, String>,
    name: &str,
    default: i64,
) -> Result<i64, Response> {
    match headers.get(name) {
        Some(value) => value.parse::<i64>().map_err(|_| {
            Response::error(
                400,
                "Bad Request",
                &format!("{name} must be a signed integer"),
            )
        }),
        None => Ok(default),
    }
}

fn validate_identifier(value: &str, max_len: usize, header: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > max_len {
        return Err(format!("{header} length must be between 1 and {max_len}"));
    }

    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
    }) {
        return Err(format!(
            "{header} may contain only ASCII alphanumeric characters and . _ - : /"
        ));
    }

    Ok(())
}

fn snapshot_json(snapshot: &TaskSnapshot) -> String {
    format!(
        concat!(
            "{{",
            "\"id\":{},",
            "\"task_name\":\"{}\",",
            "\"task_type\":\"{}\",",
            "\"priority\":{},",
            "\"max_retries\":{},",
            "\"retry_count\":{},",
            "\"status\":\"{}\",",
            "\"locked_by\":{},",
            "\"locked_until\":{},",
            "\"heartbeat_at\":{},",
            "\"error_log\":{},",
            "\"scheduled_at\":{},",
            "\"created_at\":{},",
            "\"updated_at\":{},",
            "\"lease_generation\":{}",
            "}}"
        ),
        snapshot.id,
        json_escape(&snapshot.task_name),
        json_escape(&snapshot.task_type),
        snapshot.priority,
        snapshot.max_retries,
        snapshot.retry_count,
        json_escape(&snapshot.status),
        json_option_string(snapshot.locked_by.as_deref()),
        json_option_f64(snapshot.locked_until),
        json_option_f64(snapshot.heartbeat_at),
        json_option_string(snapshot.error_log.as_deref()),
        json_f64(snapshot.scheduled_at),
        json_f64(snapshot.created_at),
        json_f64(snapshot.updated_at),
        snapshot.lease_generation,
    )
}

fn json_option_string(value: Option<&str>) -> String {
    match value {
        Some(value) => format!("\"{}\"", json_escape(value)),
        None => "null".into(),
    }
}

fn json_option_f64(value: Option<f64>) -> String {
    value.map(json_f64).unwrap_or_else(|| "null".into())
}

fn json_f64(value: f64) -> String {
    if value.is_finite() {
        value.to_string()
    } else {
        "null".into()
    }
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
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "response write timeout"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: HashMap::new(),
            body: Vec::new(),
        }
    }

    #[test]
    fn parses_http_head_case_insensitively() {
        let (_, path, headers) = parse_head(
            "POST /v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Task-Name: demo.task\r\nContent-Length: 2",
        )
        .unwrap();

        assert_eq!(path, "/v1/tasks");
        assert_eq!(headers.get("x-task-name").unwrap(), "demo.task");
        assert_eq!(headers.get("content-length").unwrap(), "2");
    }

    #[test]
    fn rejects_duplicate_content_length() {
        let error = parse_head(
            "POST /v1/tasks HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2",
        )
        .unwrap_err();
        assert_eq!(error.status, 400);
    }

    #[test]
    fn escapes_json_control_characters() {
        assert_eq!(json_escape("a\"b\\c\n"), "a\\\"b\\\\c\\n");
    }

    #[tokio::test]
    async fn enqueue_and_read_task_snapshot() {
        let db_path = std::env::temp_dir().join(format!(
            "local_api_{}.db",
            rand::random::<u64>()
        ));
        let queue = AsyncRobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().await.unwrap();
        let state = LocalApiState::new(queue, &db_path);

        let mut enqueue = request("POST", "/v1/tasks");
        enqueue
            .headers
            .insert("x-task-name".into(), "document.process".into());
        enqueue
            .headers
            .insert("x-task-type".into(), "cpu".into());
        enqueue
            .headers
            .insert("x-task-priority".into(), "9".into());
        enqueue.body = br#"{"document_id":"abc"}"#.to_vec();

        let created = route(enqueue, state.clone()).await;
        assert_eq!(created.status, 202);
        assert!(created.body.contains("\"task_id\":1"));

        let fetched = route(request("GET", "/v1/tasks/1"), state).await;
        assert_eq!(fetched.status, 200);
        assert!(fetched.body.contains("\"task_name\":\"document.process\""));
        assert!(fetched.body.contains("\"status\":\"PENDING\""));

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn enqueue_requires_explicit_task_headers() {
        let db_path = std::env::temp_dir().join(format!(
            "local_api_missing_headers_{}.db",
            rand::random::<u64>()
        ));
        let queue = AsyncRobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().await.unwrap();
        let state = LocalApiState::new(queue, &db_path);

        let response = route(request("POST", "/v1/tasks"), state).await;
        assert_eq!(response.status, 400);
        assert!(response.body.contains("missing x-task-name"));

        let _ = std::fs::remove_file(&db_path);
    }
}
