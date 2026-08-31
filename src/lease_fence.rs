use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};
use crate::value::{LeaseGeneration, LeaseMutation};

const FENCE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS task_lease_fences (
    task_id INTEGER PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
"#;

fn now_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[derive(Debug, Clone)]
pub struct FencedClaimedTask {
    pub id: i64,
    pub task_name: String,
    pub task_type: String,
    pub payload: String,
    pub retry_count: i64,
    pub max_retries: i64,
    pub lease_generation: LeaseGeneration,
}

#[derive(Debug, Clone)]
pub struct LeaseFence {
    db_path: PathBuf,
}

impl LeaseFence {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn ensure_schema(&self) -> QueueResult<()> {
        DatabaseManager::execute_with_retry(&self.db_path, |conn| {
            conn.execute_batch(FENCE_SCHEMA)?;
            Ok(())
        })
    }

    pub fn claim_task(&self, worker_id: &str) -> QueueResult<Option<FencedClaimedTask>> {
        let worker_id = worker_id.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let task = tx
                .query_row(
                    "SELECT id, task_name, task_type, payload, retry_count, max_retries
                     FROM tasks
                     WHERE status = 'ASSIGNED'
                       AND locked_by = ?1
                       AND locked_until >= ?2
                     ORDER BY priority DESC, id ASC
                     LIMIT 1",
                    params![worker_id, now],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()?;

            let Some((id, task_name, task_type, payload, retry_count, max_retries)) = task else {
                return Ok(None);
            };

            let affected = tx.execute(
                "UPDATE tasks
                 SET status = 'RUNNING',
                     heartbeat_at = ?1,
                     updated_at = ?2
                 WHERE id = ?3
                   AND status = 'ASSIGNED'
                   AND locked_by = ?4
                   AND locked_until >= ?5",
                params![now, now, id, worker_id, now],
            )?;

            if affected != 1 {
                return Ok(None);
            }

            let current_generation = tx
                .query_row(
                    "SELECT generation FROM task_lease_fences WHERE task_id = ?1",
                    params![id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);

            let next_generation = current_generation.checked_add(1).ok_or_else(|| {
                QueueError::InvalidState(format!(
                    "lease generation overflow for task_id={id}"
                ))
            })?;

            tx.execute(
                "INSERT INTO task_lease_fences (task_id, generation)
                 VALUES (?1, ?2)
                 ON CONFLICT(task_id) DO UPDATE SET generation = excluded.generation",
                params![id, next_generation],
            )?;

            tx.commit()?;

            Ok(Some(FencedClaimedTask {
                id,
                task_name,
                task_type,
                payload,
                retry_count,
                max_retries,
                lease_generation: LeaseGeneration::new(next_generation),
            }))
        })
    }

    pub fn heartbeat(
        &self,
        task_id: i64,
        worker_id: &str,
        generation: LeaseGeneration,
        extend_sec: f64,
    ) -> QueueResult<LeaseMutation> {
        let worker_id = worker_id.to_owned();
        let extend_sec = if extend_sec.is_finite() && extend_sec > 0.0 {
            extend_sec
        } else {
            10.0
        };

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let lease_until = now + extend_sec;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let affected = tx.execute(
                "UPDATE tasks
                 SET locked_until = ?1,
                     heartbeat_at = ?2,
                     updated_at = ?3
                 WHERE id = ?4
                   AND locked_by = ?5
                   AND status = 'RUNNING'
                   AND locked_until >= ?2
                   AND EXISTS (
                       SELECT 1
                       FROM task_lease_fences AS fence
                       WHERE fence.task_id = tasks.id
                         AND fence.generation = ?6
                   )",
                params![
                    lease_until,
                    now,
                    now,
                    task_id,
                    worker_id,
                    generation.value()
                ],
            )?;

            tx.commit()?;
            Ok(LeaseMutation::from_affected_rows(affected))
        })
    }

    pub fn complete_task(
        &self,
        task_id: i64,
        worker_id: &str,
        generation: LeaseGeneration,
    ) -> QueueResult<LeaseMutation> {
        let worker_id = worker_id.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let affected = tx.execute(
                "UPDATE tasks
                 SET status = 'COMPLETED',
                     locked_by = NULL,
                     locked_until = NULL,
                     heartbeat_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2
                   AND locked_by = ?3
                   AND status = 'RUNNING'
                   AND locked_until >= ?1
                   AND EXISTS (
                       SELECT 1
                       FROM task_lease_fences AS fence
                       WHERE fence.task_id = tasks.id
                         AND fence.generation = ?4
                   )",
                params![now, task_id, worker_id, generation.value()],
            )?;

            tx.commit()?;
            Ok(LeaseMutation::from_affected_rows(affected))
        })
    }

    pub fn fail_task(
        &self,
        task_id: i64,
        worker_id: &str,
        generation: LeaseGeneration,
        error_msg: &str,
    ) -> QueueResult<LeaseMutation> {
        let worker_id = worker_id.to_owned();
        let error_msg = error_msg.to_owned();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let retry_state = tx
                .query_row(
                    "SELECT retry_count, max_retries
                     FROM tasks
                     WHERE id = ?1
                       AND locked_by = ?2
                       AND status = 'RUNNING'
                       AND locked_until >= ?3
                       AND EXISTS (
                           SELECT 1
                           FROM task_lease_fences AS fence
                           WHERE fence.task_id = tasks.id
                             AND fence.generation = ?4
                       )",
                    params![task_id, worker_id, now, generation.value()],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;

            let Some((retry_count, max_retries)) = retry_state else {
                return Ok(LeaseMutation::Stale);
            };

            let affected = if retry_count + 1 >= max_retries {
                tx.execute(
                    "UPDATE tasks
                     SET status = 'FAILED',
                         retry_count = retry_count + 1,
                         locked_by = NULL,
                         locked_until = NULL,
                         heartbeat_at = NULL,
                         error_log = ?1,
                         updated_at = ?2
                     WHERE id = ?3
                       AND locked_by = ?4
                       AND status = 'RUNNING'
                       AND locked_until >= ?2
                       AND EXISTS (
                           SELECT 1
                           FROM task_lease_fences AS fence
                           WHERE fence.task_id = tasks.id
                             AND fence.generation = ?5
                       )",
                    params![error_msg, now, task_id, worker_id, generation.value()],
                )?
            } else {
                let capped_retry = retry_count.clamp(0, 20);
                let backoff_seconds = 2.0f64.powi(capped_retry as i32) * 2.0;
                let scheduled_next = now + backoff_seconds;

                tx.execute(
                    "UPDATE tasks
                     SET status = 'PENDING',
                         retry_count = retry_count + 1,
                         locked_by = NULL,
                         locked_until = NULL,
                         heartbeat_at = NULL,
                         scheduled_at = ?1,
                         error_log = ?2,
                         updated_at = ?3
                     WHERE id = ?4
                       AND locked_by = ?5
                       AND status = 'RUNNING'
                       AND locked_until >= ?3
                       AND EXISTS (
                           SELECT 1
                           FROM task_lease_fences AS fence
                           WHERE fence.task_id = tasks.id
                             AND fence.generation = ?6
                       )",
                    params![
                        scheduled_next,
                        error_msg,
                        now,
                        task_id,
                        worker_id,
                        generation.value()
                    ],
                )?
            };

            tx.commit()?;
            Ok(LeaseMutation::from_affected_rows(affected))
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
}
