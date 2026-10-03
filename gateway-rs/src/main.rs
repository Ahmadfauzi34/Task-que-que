//! Task-que-que Gateway (Rust)

mod config;
mod db;
mod handlers;
mod models;

use axum::{
    routing::{get, post},
    Router,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tracing::info;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub tokens: Mutex<HashMap<String, String>>,
    pub presence: Mutex<HashMap<String, PresenceInfo>>,
}

#[derive(Clone)]
pub struct PresenceInfo {
    pub agent_id: String,
    pub tools: Vec<String>,
    pub last_seen: i64,
}

static STATE: OnceLock<Arc<AppState>> = OnceLock::new();

pub fn get_state() -> Arc<AppState> {
    STATE.get().expect("State not initialized").clone()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = config::Config::from_env();
    info!("Starting tqq-gateway-rs on :{}", config.port);

    let conn = db::open(&config.db_path).expect("Failed to open DB");
    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        tokens: Mutex::new(HashMap::new()),
        presence: Mutex::new(HashMap::new()),
    });
    STATE.set(state).expect("State already set");

    let app = Router::new()
        .route("/health", get(handlers::health::handler))
        .route("/v1/agent/register", post(handlers::agent::register))
        .route("/v1/agent/poll", post(handlers::agent::poll))
        .route("/v1/agent/result", post(handlers::agent::submit_result))
        .route("/v1/agent/heartbeat", post(handlers::agent::heartbeat));

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    info!("Listening on {}", addr);
    axum::serve(listener, app).await.expect("Server error");
}
