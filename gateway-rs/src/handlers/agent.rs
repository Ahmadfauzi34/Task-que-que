//! Agent protocol handlers.

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rand::Rng;
use serde_json::{json, Value};

use crate::{db, get_state, models::*, PresenceInfo};

fn verify_token(headers: &HeaderMap, agent_id: &str) -> bool {
    let token = headers
        .get("X-Agent-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let state = get_state();
    let tokens = state.tokens.lock().unwrap();
    match tokens.get(token) {
        Some(stored_id) => stored_id == agent_id,
        None => false,
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

/// POST /v1/agent/register
pub async fn register(Json(req): Json<RegisterRequest>) -> Response {
    if req.agent_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "agent_id required" }),
        );
    }

    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    let token = hex::encode(bytes);

    let state = get_state();
    {
        let mut tokens = state.tokens.lock().unwrap();
        tokens.insert(token.clone(), req.agent_id.clone());
    }

    {
        let mut presence = state.presence.lock().unwrap();
        presence.insert(
            req.agent_id.clone(),
            PresenceInfo {
                agent_id: req.agent_id.clone(),
                tools: req.tools.clone(),
                last_seen: chrono::Utc::now().timestamp(),
            },
        );
    }

    json_response(
        StatusCode::OK,
        json!({ "token": token, "agent_id": req.agent_id }),
    )
}

/// POST /v1/agent/poll
pub async fn poll(headers: HeaderMap, Json(req): Json<PollRequest>) -> Response {
    if req.agent_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "agent_id required" }),
        );
    }

    if !verify_token(&headers, &req.agent_id) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid agent token" }),
        );
    }

    let state = get_state();
    let db = state.db.lock().unwrap();

    if let Err(e) = db::auto_release_expired(&db) {
        tracing::warn!("auto-release failed: {}", e);
    }

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
        None => return json_response(StatusCode::NO_CONTENT, Value::Null),
    };

    let targets = check_targets_agent(&task_name, &payload_json, &req.agent_id);
    if !targets {
        let _ = db.execute(
            "UPDATE tasks SET status = 'PENDING', locked_by = NULL, locked_until = NULL WHERE id = ?",
            [&task_id],
        );
        return json_response(StatusCode::NO_CONTENT, Value::Null);
    }

    json_response(
        StatusCode::OK,
        json!({
            "task": {
                "id": task_id,
                "type": task_name,
                "payload_json": payload_json,
            }
        }),
    )
}

fn check_targets_agent(task_name: &str, payload_json: &str, agent_id: &str) -> bool {
    let payload: Value = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(_) => return false,
    };

    match task_name {
        "workflow.run" => {
            if let Some(steps) = payload.get("steps").and_then(|s| s.as_array()) {
                steps
                    .iter()
                    .any(|s| s.get("agent").and_then(|a| a.as_str()) == Some(agent_id))
            } else {
                false
            }
        }
        "agent.invoke" => payload.get("agent").and_then(|a| a.as_str()) == Some(agent_id),
        _ => false,
    }
}

/// POST /v1/agent/result
pub async fn submit_result(headers: HeaderMap, Json(req): Json<ResultRequest>) -> Response {
    if !verify_token(&headers, &req.agent_id) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid agent token" }),
        );
    }

    let state = get_state();
    let db = state.db.lock().unwrap();
    let now = chrono::Utc::now().timestamp() as f64;
    let result_str = req.result.to_string();

    let lease_gen: i64 = db
        .query_row(
            "SELECT COALESCE(lease_generation, 0) FROM tasks WHERE id = ?",
            [&req.task_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let r1 = db.execute(
        "INSERT INTO task_results (task_id, result_bytes, lease_generation, completed_at)
         VALUES (?, ?, ?, ?)",
        rusqlite::params![req.task_id, result_str.as_bytes(), lease_gen, now],
    );

    let r2 = db.execute(
        "UPDATE tasks SET status = 'COMPLETED', locked_by = NULL, locked_until = NULL
         WHERE id = ? AND locked_by = ?",
        rusqlite::params![req.task_id, req.agent_id],
    );

    match (r1, r2) {
        (Ok(_), Ok(_)) => json_response(StatusCode::OK, json!({ "ok": true })),
        _ => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "failed to save result" }),
        ),
    }
}

/// POST /v1/agent/heartbeat
pub async fn heartbeat(headers: HeaderMap, Json(req): Json<HeartbeatRequest>) -> Response {
    let has_token = headers.get("X-Agent-Token").is_some();
    if has_token && !verify_token(&headers, &req.agent_id) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid agent token" }),
        );
    }

    let state = get_state();
    {
        let mut presence = state.presence.lock().unwrap();
        presence.insert(
            req.agent_id.clone(),
            PresenceInfo {
                agent_id: req.agent_id.clone(),
                tools: req.tools,
                last_seen: chrono::Utc::now().timestamp(),
            },
        );
    }

    json_response(StatusCode::OK, json!({ "ok": true }))
}
