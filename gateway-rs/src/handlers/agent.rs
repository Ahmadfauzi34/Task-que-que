//! Agent protocol handlers.
//!
//! - POST /v1/agent/register
//! - POST /v1/agent/poll
//! - POST /v1/agent/result
//! - POST /v1/agent/heartbeat

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use rand::Rng;
use serde_json::json;

use crate::{
    db,
    models::*,
    AppState, PresenceInfo,
};

/// Verifikasi token dari header X-Agent-Token.
async fn verify_token(
    headers: &HeaderMap,
    agent_id: &str,
    state: &AppState,
) -> bool {
    let token = headers
        .get("X-Agent-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let tokens = state.tokens.lock().await;
    match tokens.get(token) {
        Some(stored_id) => stored_id == agent_id,
        None => false,
    }
}

/// POST /v1/agent/register
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if req.agent_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "agent_id required" })),
        );
    }

    // Generate token 64-char hex (32 bytes)
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    let token = hex::encode(bytes);

    // Simpan token -> agent_id
    {
        let mut tokens = state.tokens.lock().await;
        tokens.insert(token.clone(), req.agent_id.clone());
    }

    // Update presence
    {
        let mut presence = state.presence.lock().await;
        presence.insert(
            req.agent_id.clone(),
            PresenceInfo {
                agent_id: req.agent_id.clone(),
                tools: req.tools.clone(),
                last_seen: chrono::Utc::now().timestamp(),
            },
        );
    }

    (
        StatusCode::OK,
        Json(json!({
            "token": token,
            "agent_id": req.agent_id,
        })),
    )
}

/// POST /v1/agent/poll
pub async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PollRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if req.agent_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "agent_id required" })),
        );
    }

    if !verify_token(&headers, &req.agent_id, &state).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid agent token" })),
        );
    }

    let db = state.db.lock().await;

    // Auto-release expired
    if let Err(e) = db::auto_release_expired(&db) {
        tracing::warn!("auto-release failed: {}", e);
    }

    // Claim satu task PENDING
    let now = chrono::Utc::now().timestamp() as f64;
    let lease_until = now + 60.0;

    let task: Option<(String, String, String)> = db
        .query_row(
            "UPDATE tasks SET status = 'CLAIMED', locked_by = ?, locked_until = ?
             WHERE id = (
               SELECT id FROM tasks
               WHERE status = 'PENDING'
                 AND task_name IN ('workflow.run', 'agent.invoke')
                 AND scheduled_at <= ?
               ORDER BY priority DESC, id ASC
               LIMIT 1
             )
             RETURNING id, task_name, payload",
            rusqlite::params![req.agent_id, lease_until, now],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    let (task_id, task_name, payload_json) = match task {
        Some(t) => t,
        None => return (StatusCode::NO_CONTENT, Json(json!(null))),
    };

    // Filter: hanya untuk agent ini (cek payload)
    let targets_this_agent = check_targets_agent(&task_name, &payload_json, &req.agent_id);

    if !targets_this_agent {
        // Kembalikan ke PENDING
        let _ = db.execute(
            "UPDATE tasks SET status = 'PENDING', locked_by = NULL, locked_until = NULL WHERE id = ?",
            [&task_id],
        );
        return (StatusCode::NO_CONTENT, Json(json!(null)));
    }

    (
        StatusCode::OK,
        Json(json!({
            "task": {
                "id": task_id,
                "type": task_name,
                "payload_json": payload_json,
            }
        })),
    )
}

/// Cek apakah task menargetkan agent ini (berdasarkan payload).
fn check_targets_agent(task_name: &str, payload_json: &str, agent_id: &str) -> bool {
    let payload: serde_json::Value = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(_) => return false,
    };

    match task_name {
        "workflow.run" => {
            if let Some(steps) = payload.get("steps").and_then(|s| s.as_array()) {
                steps.iter().any(|s| {
                    s.get("agent").and_then(|a| a.as_str()) == Some(agent_id)
                })
            } else {
                false
            }
        }
        "agent.invoke" => {
            payload.get("agent").and_then(|a| a.as_str()) == Some(agent_id)
        }
        _ => false,
    }
}

/// POST /v1/agent/result
pub async fn submit_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ResultRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if !verify_token(&headers, &req.agent_id, &state).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid agent token" })),
        );
    }

    let db = state.db.lock().await;
    let now = chrono::Utc::now().timestamp() as f64;
    let result_str = req.result.to_string();

    // Simpan hasil dan tandai COMPLETED
    // (sesuai schema: result_bytes dan lease_generation wajib)
    let tx_result: rusqlite::Result<()> = (|| {
        // Ambil lease_generation saat ini
        let lease_gen: i64 = db.query_row(
            "SELECT COALESCE(lease_generation, 0) FROM tasks WHERE id = ?",
            [&req.task_id],
            |row| row.get(0),
        ).unwrap_or(0);

        db.execute(
            "INSERT INTO task_results (task_id, result_bytes, lease_generation, completed_at)
             VALUES (?, ?, ?, ?)",
            rusqlite::params![req.task_id, result_str.as_bytes(), lease_gen, now],
        )?;

        db.execute(
            "UPDATE tasks SET status = 'COMPLETED', locked_by = NULL, locked_until = NULL
             WHERE id = ? AND locked_by = ?",
            rusqlite::params![req.task_id, req.agent_id],
        )?;

        Ok(())
    })();

    match tx_result {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            tracing::warn!("submit_result failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "failed to save result" })),
            )
        }
    }
}

/// POST /v1/agent/heartbeat
pub async fn heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<HeartbeatRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Heartbeat boleh tanpa token (presence saja), tapi verifikasi jika ada
    let has_token = headers.get("X-Agent-Token").is_some();
    if has_token && !verify_token(&headers, &req.agent_id, &state).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid agent token" })),
        );
    }

    {
        let mut presence = state.presence.lock().await;
        presence.insert(
            req.agent_id.clone(),
            PresenceInfo {
                agent_id: req.agent_id.clone(),
                tools: req.tools,
                last_seen: chrono::Utc::now().timestamp(),
            },
        );
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}
