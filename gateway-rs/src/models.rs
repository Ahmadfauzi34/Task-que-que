//! Request/response models.

use serde::{Deserialize, Serialize};

// --- Register ---

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub agent_id: String,
    pub tools: Vec<String>,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    pub token: String,
    pub agent_id: String,
}

// --- Poll ---

#[derive(Deserialize)]
pub struct PollRequest {
    pub agent_id: String,
}

#[derive(Serialize)]
pub struct PollResponse {
    pub task: TaskInfo,
}

#[derive(Serialize)]
pub struct TaskInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub payload_json: String,
}

// --- Result ---

#[derive(Deserialize)]
pub struct ResultRequest {
    pub task_id: String,
    pub agent_id: String,
    pub result: serde_json::Value,
}

#[derive(Serialize)]
pub struct ResultResponse {
    pub ok: bool,
}

// --- Heartbeat ---

#[derive(Deserialize)]
pub struct HeartbeatRequest {
    pub agent_id: String,
    pub tools: Vec<String>,
}

// --- Error ---

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}
