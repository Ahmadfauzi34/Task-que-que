//! Task-que-que Gateway (Rust)
//!
//! Minimal, stable gateway untuk agent protocol.
//! Fokus: low memory, predictable, tidak di-kill.
//!
//! Endpoints:
//! - POST /v1/agent/register   — registrasi agen
//! - POST /v1/agent/poll       — poll task
//! - POST /v1/agent/result     — lapor hasil
//! - POST /v1/agent/heartbeat  — heartbeat
//! - GET  /health              — health check

mod config;
mod db;
mod handlers;
mod models;

use axum::{
    routing::{get, post},
    Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

#[derive(Clone)]
pub struct AppState {
    db: Arc<Mutex<rusqlite::Connection>>,
    tokens: Arc<Mutex<std::collections::HashMap<String, String>>>, // token -> agent_id
    presence: Arc<Mutex<std::collections::HashMap<String, PresenceInfo>>>,
}

#[derive(Clone)]
pub struct PresenceInfo {
    pub agent_id: String,
    pub tools: Vec<String>,
    pub last_seen: i64,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = config::Config::from_env();
    info!("Starting tqq-gateway-rs on :{}", config.port);
    info!("DB: {}", config.db_path);

    let conn = db::open(&config.db_path).expect("Failed to open DB");
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        tokens: Arc::new(Mutex::new(std::collections::HashMap::new())),
        presence: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    let app = Router::new()
        .route("/health", get(handlers::health::handler))
        .route("/v1/agent/register", post(handlers::agent::register))
        .route("/v1/agent/poll", post(handlers::agent::poll))
        .route("/v1/agent/result", post(handlers::agent::submit_result))
        .route("/v1/agent/heartbeat", post(handlers::agent::heartbeat))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    info!("Listening on {}", addr);
    axum::serve(listener, app).await.expect("Server error");
}
