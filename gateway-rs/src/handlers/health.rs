//! Health check endpoint.

use axum::{http::StatusCode, Json};
use serde_json::{json, Value};

pub async fn handler() -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({ "status": "ok", "service": "tqq-gateway-rs" })))
}
