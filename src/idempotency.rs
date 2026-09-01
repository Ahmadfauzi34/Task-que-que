use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};

const IDEMPOTENCY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS task_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    created_at REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_idempotency_task_id
    ON task_idempotency (task_id);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdempotentEnqueueResult {
    Created(i64),
    Replayed(i64),
    Conflict,
    Full {
        active_tasks: i64,
        max_active_tasks: i64,
    },
}

#[derive(Debug, Clone)]
pub struct IdempotencyStore {
    db_path: PathBuf,
}

impl IdempotencyStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn ensure_schema(&self) -> QueueResult<()> {
        DatabaseManager::execute_with_retry(&self.db_path, |conn| {
            conn.execute_batch(IDEMPOTENCY_SCHEMA)?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue(
        &self,
        idempotency_key: &str,
        request_fingerprint: &str,
        task_name: &str,
        task_type: &str,
        payload: &str,
        priority: i64,
        max_retries: i64,
    ) -> QueueResult<IdempotentEnqueueResult> {
        self.enqueue_bounded(
            idempotency_key,
            request_fingerprint,
            task_name,
            task_type,
            payload,
            priority,
            max_retries,
            i64::MAX,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_bounded(
        &self,
        idempotency_key: &str,
        request_fingerprint: &str,
        task_name: &str,
        task_type: &str,
        payload: &str,
        priority: i64,
        max_retries: i64,
        max_active_tasks: i64,
    ) -> QueueResult<IdempotentEnqueueResult> {
        if max_active_tasks <= 0 {
            return Err(QueueError::InvalidState(
                "max_active_tasks must be greater than zero".into(),
            ));
        }

        let idempotency_key = idempotency_key.to_owned();
        let request_fingerprint = request_fingerprint.to_owned();
        let task_name = task_name.to_owned();
        let task_type = task_type.to_owned();
        let payload = payload.to_owned();
        let now = now_f64();

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let existing = tx
                .query_row(
                    "SELECT request_fingerprint, task_id
                     FROM task_idempotency
                     WHERE idempotency_key = ?1",
                    params![idempotency_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;

            if let Some((existing_fingerprint, task_id)) = existing {
                tx.commit()?;
                return if existing_fingerprint == request_fingerprint {
                    Ok(IdempotentEnqueueResult::Replayed(task_id))
                } else {
                    Ok(IdempotentEnqueueResult::Conflict)
                };
            }

            let active_tasks: i64 = tx.query_row(
                "SELECT COUNT(*)
                 FROM tasks
                 WHERE status IN ('PENDING', 'ASSIGNED', 'RUNNING')",
                [],
                |row| row.get(0),
            )?;

            if active_tasks >= max_active_tasks {
                tx.commit()?;
                return Ok(IdempotentEnqueueResult::Full {
                    active_tasks,
                    max_active_tasks,
                });
            }

            tx.execute(
                "INSERT INTO tasks
                    (
                        task_name,
                        task_type,
                        payload,
                        priority,
                        max_retries,
                        status,
                        retry_count,
                        scheduled_at,
                        created_at,
                        updated_at
                    )
                 VALUES
                    (?1, ?2, ?3, ?4, ?5, 'PENDING', 0, ?6, ?7, ?8)",
                params![
                    task_name,
                    task_type,
                    payload,
                    priority,
                    max_retries,
                    now,
                    now,
                    now
                ],
            )?;

            let task_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO task_idempotency
                    (idempotency_key, request_fingerprint, task_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![idempotency_key, request_fingerprint, task_id, now],
            )?;

            tx.commit()?;
            Ok(IdempotentEnqueueResult::Created(task_id))
        })
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
    use std::path::Path;
    use std::sync::{Arc, Barrier};
    use std::thread;

    use rusqlite::Connection;

    use super::*;
    use crate::sync_queue::RobustSinkhornQueue;

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}.db", rand::random::<u64>()))
    }

    fn prepare(path: &Path) -> IdempotencyStore {
        RobustSinkhornQueue::new(path).ensure_schema().unwrap();
        let store = IdempotencyStore::new(path);
        store.ensure_schema().unwrap();
        store
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn replay_survives_store_reconstruction_and_conflict_does_not_duplicate() {
        let db_path = temp_db("idempotency_restart");
        let store = prepare(&db_path);

        let created = store
            .enqueue("request-1", "fp-a", "document.process", "cpu", "{}", 10, 3)
            .unwrap();
        assert_eq!(created, IdempotentEnqueueResult::Created(1));

        let reconstructed = IdempotencyStore::new(&db_path);
        reconstructed.ensure_schema().unwrap();
        let replayed = reconstructed
            .enqueue("request-1", "fp-a", "document.process", "cpu", "{}", 10, 3)
            .unwrap();
        assert_eq!(replayed, IdempotentEnqueueResult::Replayed(1));

        let conflict = reconstructed
            .enqueue(
                "request-1",
                "fp-b",
                "document.process",
                "cpu",
                r#"{"changed":true}"#,
                10,
                3,
            )
            .unwrap();
        assert_eq!(conflict, IdempotentEnqueueResult::Conflict);

        let conn = Connection::open(&db_path).unwrap();
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 1);

        cleanup(&db_path);
    }

    #[test]
    fn replay_precedes_capacity_check_and_new_key_is_rejected_when_full() {
        let db_path = temp_db("idempotency_capacity_replay");
        let store = prepare(&db_path);

        let created = store
            .enqueue_bounded(
                "request-1",
                "fp-a",
                "document.process",
                "cpu",
                "{}",
                10,
                3,
                1,
            )
            .unwrap();
        assert_eq!(created, IdempotentEnqueueResult::Created(1));

        let replayed = store
            .enqueue_bounded(
                "request-1",
                "fp-a",
                "document.process",
                "cpu",
                "{}",
                10,
                3,
                1,
            )
            .unwrap();
        assert_eq!(replayed, IdempotentEnqueueResult::Replayed(1));

        let full = store
            .enqueue_bounded(
                "request-2",
                "fp-b",
                "document.process",
                "cpu",
                "{}",
                10,
                3,
                1,
            )
            .unwrap();
        assert_eq!(
            full,
            IdempotentEnqueueResult::Full {
                active_tasks: 1,
                max_active_tasks: 1,
            }
        );

        let conn = Connection::open(&db_path).unwrap();
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 1);

        cleanup(&db_path);
    }

    #[test]
    fn concurrent_distinct_keys_cannot_overshoot_active_capacity() {
        let db_path = temp_db("idempotency_capacity_concurrent");
        prepare(&db_path);

        let workers = 8;
        let barrier = Arc::new(Barrier::new(workers));
        let mut handles = Vec::new();

        for index in 0..workers {
            let path = db_path.clone();
            let barrier = barrier.clone();
            handles.push(thread::spawn(move || {
                let store = IdempotencyStore::new(path);
                barrier.wait();
                store
                    .enqueue_bounded(
                        &format!("key-{index}"),
                        &format!("fp-{index}"),
                        "document.process",
                        "cpu",
                        "{}",
                        0,
                        3,
                        1,
                    )
                    .unwrap()
            }));
        }

        let results: Vec<IdempotentEnqueueResult> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, IdempotentEnqueueResult::Created(_)))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, IdempotentEnqueueResult::Full { .. }))
                .count(),
            workers - 1
        );

        let conn = Connection::open(&db_path).unwrap();
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 1);

        cleanup(&db_path);
    }

    #[test]
    fn concurrent_same_key_creates_exactly_one_task() {
        let db_path = temp_db("idempotency_concurrent");
        prepare(&db_path);

        let workers = 8;
        let barrier = Arc::new(Barrier::new(workers));
        let mut handles = Vec::new();

        for _ in 0..workers {
            let path = db_path.clone();
            let barrier = barrier.clone();
            handles.push(thread::spawn(move || {
                let store = IdempotencyStore::new(path);
                barrier.wait();
                store
                    .enqueue(
                        "same-key",
                        "same-fingerprint",
                        "document.process",
                        "cpu",
                        r#"{"id":1}"#,
                        0,
                        3,
                    )
                    .unwrap()
            }));
        }

        let results: Vec<IdempotentEnqueueResult> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, IdempotentEnqueueResult::Created(_)))
                .count(),
            1
        );
        assert!(results.iter().all(|result| match result {
            IdempotentEnqueueResult::Created(id) | IdempotentEnqueueResult::Replayed(id) => {
                *id == 1
            }
            IdempotentEnqueueResult::Conflict | IdempotentEnqueueResult::Full { .. } => false,
        }));

        let conn = Connection::open(&db_path).unwrap();
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        let key_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_idempotency", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(task_count, 1);
        assert_eq!(key_count, 1);

        cleanup(&db_path);
    }
}
