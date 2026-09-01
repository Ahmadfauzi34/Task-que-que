use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};
use crate::value::{LeaseGeneration, LeaseMutation};

pub const MAX_RESULT_PROJECTION_BYTES: usize = 256 * 1024;

const RESULT_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS task_results (
    task_id INTEGER PRIMARY KEY,
    result_json TEXT NOT NULL,
    result_bytes INTEGER NOT NULL,
    lease_generation INTEGER NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskResultProjection {
    pub task_id: i64,
    pub result_json: String,
    pub result_bytes: i64,
}

#[derive(Debug, Clone)]
pub struct TaskResultStore {
    db_path: PathBuf,
}

impl TaskResultStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn ensure_schema(&self) -> QueueResult<()> {
        DatabaseManager::execute_with_retry(&self.db_path, |conn| {
            conn.execute_batch(RESULT_SCHEMA)?;
            Ok(())
        })
    }

    pub fn complete_with_projection(
        &self,
        task_id: i64,
        worker_id: &str,
        generation: LeaseGeneration,
        result_json: &str,
    ) -> QueueResult<LeaseMutation> {
        if result_json.is_empty() {
            return Err(QueueError::InvalidState(
                "result projection must not be empty".into(),
            ));
        }
        if result_json.len() > MAX_RESULT_PROJECTION_BYTES {
            return Err(QueueError::InvalidState(format!(
                "result projection exceeds {} bytes",
                MAX_RESULT_PROJECTION_BYTES
            )));
        }

        let worker_id = worker_id.to_owned();
        let result_json = result_json.to_owned();

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

            if affected == 1 {
                tx.execute(
                    "INSERT INTO task_results
                        (task_id, result_json, result_bytes, lease_generation, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        task_id,
                        result_json,
                        result_json.len() as i64,
                        generation.value(),
                        now
                    ],
                )?;
            }

            tx.commit()?;
            Ok(LeaseMutation::from_affected_rows(affected))
        })
    }

    pub fn get(&self, task_id: i64) -> QueueResult<Option<TaskResultProjection>> {
        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            conn.query_row(
                "SELECT r.task_id, r.result_json, r.result_bytes
                 FROM task_results AS r
                 INNER JOIN tasks AS t ON t.id = r.task_id
                 WHERE r.task_id = ?1
                   AND t.status = 'COMPLETED'",
                params![task_id],
                |row| {
                    Ok(TaskResultProjection {
                        task_id: row.get(0)?,
                        result_json: row.get(1)?,
                        result_bytes: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
}

fn now_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lease_fence::LeaseFence;
    use crate::sync_queue::{DatabaseManager, RobustSinkhornQueue};

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}.db", rand::random::<u64>()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    fn running_task(db_path: &Path, worker: &str) -> (i64, LeaseGeneration) {
        let queue = RobustSinkhornQueue::new(db_path);
        queue.ensure_schema().unwrap();
        let id = queue.enqueue_simple("hash.compute", "cpu", "{}").unwrap();
        DatabaseManager::execute_with_retry(db_path, |conn| {
            let now = now_f64();
            conn.execute(
                "UPDATE tasks
                 SET status = 'ASSIGNED', locked_by = ?1, locked_until = ?2
                 WHERE id = ?3",
                params![worker, now + 60.0, id],
            )?;
            Ok(())
        })
        .unwrap();
        let fence = LeaseFence::new(db_path);
        fence.ensure_schema().unwrap();
        let claimed = fence.claim_task(worker).unwrap().unwrap();
        (id, claimed.lease_generation)
    }

    #[test]
    fn stores_projection_only_with_valid_fenced_completion() {
        let db_path = temp_db("result_projection");
        let (task_id, generation) = running_task(&db_path, "worker-a");
        let store = TaskResultStore::new(&db_path);
        store.ensure_schema().unwrap();

        let stale = store
            .complete_with_projection(
                task_id,
                "worker-a",
                LeaseGeneration::new(generation.value() + 1),
                r#"{"digest":"stale"}"#,
            )
            .unwrap();
        assert_eq!(stale, LeaseMutation::Stale);
        assert_eq!(store.get(task_id).unwrap(), None);

        let applied = store
            .complete_with_projection(
                task_id,
                "worker-a",
                generation,
                r#"{"digest":"abc"}"#,
            )
            .unwrap();
        assert_eq!(applied, LeaseMutation::Applied);
        let result = store.get(task_id).unwrap().unwrap();
        assert_eq!(result.task_id, task_id);
        assert_eq!(result.result_json, r#"{"digest":"abc"}"#);
        assert_eq!(result.result_bytes, 16);

        cleanup(&db_path);
    }

    #[test]
    fn rejects_empty_and_oversized_projection_before_state_mutation() {
        let db_path = temp_db("result_projection_bounds");
        let (task_id, generation) = running_task(&db_path, "worker-b");
        let store = TaskResultStore::new(&db_path);
        store.ensure_schema().unwrap();

        assert!(store
            .complete_with_projection(task_id, "worker-b", generation, "")
            .is_err());
        assert!(store
            .complete_with_projection(
                task_id,
                "worker-b",
                generation,
                &"x".repeat(MAX_RESULT_PROJECTION_BYTES + 1),
            )
            .is_err());

        let status: String = DatabaseManager::execute_with_retry(&db_path, |conn| {
            Ok(conn.query_row(
                "SELECT status FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
        assert_eq!(status, "RUNNING");
        assert_eq!(store.get(task_id).unwrap(), None);

        cleanup(&db_path);
    }
}
