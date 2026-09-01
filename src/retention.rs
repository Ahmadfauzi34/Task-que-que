use std::path::PathBuf;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalRetentionResult {
    pub terminal_before: i64,
    pub retained_terminal: i64,
    pub pruned_tasks: i64,
    pub pruned_idempotency: i64,
    pub pruned_fences: i64,
}

#[derive(Debug, Clone)]
pub struct TerminalRetentionStore {
    db_path: PathBuf,
}

impl TerminalRetentionStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn prune_to_max(&self, max_terminal_tasks: i64) -> QueueResult<TerminalRetentionResult> {
        if max_terminal_tasks <= 0 {
            return Err(QueueError::InvalidState(
                "max_terminal_tasks must be greater than zero".into(),
            ));
        }

        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let terminal_before: i64 = tx.query_row(
                "SELECT COUNT(*) FROM tasks WHERE status IN ('COMPLETED', 'FAILED')",
                [],
                |row| row.get(0),
            )?;

            if terminal_before <= max_terminal_tasks {
                tx.commit()?;
                return Ok(TerminalRetentionResult {
                    terminal_before,
                    retained_terminal: terminal_before,
                    pruned_tasks: 0,
                    pruned_idempotency: 0,
                    pruned_fences: 0,
                });
            }

            let prune_count = terminal_before - max_terminal_tasks;
            let idempotency_exists = table_exists(&tx, "task_idempotency")?;
            let fences_exist = table_exists(&tx, "task_lease_fences")?;

            let pruned_idempotency = if idempotency_exists {
                tx.execute(
                    "DELETE FROM task_idempotency
                     WHERE task_id IN (
                         SELECT id
                         FROM tasks
                         WHERE status IN ('COMPLETED', 'FAILED')
                         ORDER BY updated_at ASC, id ASC
                         LIMIT ?1
                     )",
                    params![prune_count],
                )? as i64
            } else {
                0
            };

            let pruned_fences = if fences_exist {
                tx.execute(
                    "DELETE FROM task_lease_fences
                     WHERE task_id IN (
                         SELECT id
                         FROM tasks
                         WHERE status IN ('COMPLETED', 'FAILED')
                         ORDER BY updated_at ASC, id ASC
                         LIMIT ?1
                     )",
                    params![prune_count],
                )? as i64
            } else {
                0
            };

            let pruned_tasks = tx.execute(
                "DELETE FROM tasks
                 WHERE id IN (
                     SELECT id
                     FROM tasks
                     WHERE status IN ('COMPLETED', 'FAILED')
                     ORDER BY updated_at ASC, id ASC
                     LIMIT ?1
                 )
                   AND status IN ('COMPLETED', 'FAILED')",
                params![prune_count],
            )? as i64;

            if pruned_tasks != prune_count {
                return Err(QueueError::InvalidState(format!(
                    "terminal retention selected {prune_count} tasks but deleted {pruned_tasks}"
                )));
            }

            tx.commit()?;
            Ok(TerminalRetentionResult {
                terminal_before,
                retained_terminal: terminal_before - pruned_tasks,
                pruned_tasks,
                pruned_idempotency,
                pruned_fences,
            })
        })
    }

    pub async fn prune_to_max_async(
        &self,
        max_terminal_tasks: i64,
    ) -> QueueResult<TerminalRetentionResult> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.prune_to_max(max_terminal_tasks))
            .await
            .map_err(|error| {
                QueueError::InvalidState(format!("terminal retention task join error: {error}"))
            })?
    }
}

fn table_exists(tx: &rusqlite::Transaction<'_>, name: &str) -> QueueResult<bool> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::Connection;

    use super::*;
    use crate::idempotency::IdempotencyStore;
    use crate::lease_fence::LeaseFence;
    use crate::sync_queue::RobustSinkhornQueue;

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}.db", rand::random::<u64>()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    fn insert_task(conn: &Connection, id: i64, status: &str, updated_at: f64) {
        conn.execute(
            "INSERT INTO tasks (
                id, task_name, task_type, payload, priority, max_retries, retry_count,
                status, scheduled_at, created_at, updated_at
             ) VALUES (?1, ?2, 'cpu', '{}', 0, 3, 0, ?3, ?4, ?4, ?4)",
            params![id, format!("task-{id}"), status, updated_at],
        )
        .unwrap();
    }

    #[test]
    fn prunes_oldest_terminal_rows_and_related_state_atomically() {
        let db_path = temp_db("terminal_retention");
        RobustSinkhornQueue::new(&db_path).ensure_schema().unwrap();
        IdempotencyStore::new(&db_path).ensure_schema().unwrap();
        LeaseFence::new(&db_path).ensure_schema().unwrap();

        let conn = Connection::open(&db_path).unwrap();
        insert_task(&conn, 1, "COMPLETED", 1.0);
        insert_task(&conn, 2, "FAILED", 2.0);
        insert_task(&conn, 3, "COMPLETED", 3.0);
        insert_task(&conn, 4, "FAILED", 4.0);
        insert_task(&conn, 5, "PENDING", 0.5);

        for id in 1..=4 {
            conn.execute(
                "INSERT INTO task_idempotency
                    (idempotency_key, request_fingerprint, task_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![format!("key-{id}"), format!("fp-{id}"), id, id as f64],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_lease_fences (task_id, generation) VALUES (?1, ?2)",
                params![id, id],
            )
            .unwrap();
        }
        drop(conn);

        let result = TerminalRetentionStore::new(&db_path)
            .prune_to_max(2)
            .unwrap();
        assert_eq!(
            result,
            TerminalRetentionResult {
                terminal_before: 4,
                retained_terminal: 2,
                pruned_tasks: 2,
                pruned_idempotency: 2,
                pruned_fences: 2,
            }
        );

        let conn = Connection::open(&db_path).unwrap();
        let remaining_tasks: Vec<i64> = conn
            .prepare("SELECT id FROM tasks ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(remaining_tasks, vec![3, 4, 5]);

        let remaining_idempotency: Vec<i64> = conn
            .prepare("SELECT task_id FROM task_idempotency ORDER BY task_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(remaining_idempotency, vec![3, 4]);

        let remaining_fences: Vec<i64> = conn
            .prepare("SELECT task_id FROM task_lease_fences ORDER BY task_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(remaining_fences, vec![3, 4]);
        drop(conn);

        let second = TerminalRetentionStore::new(&db_path)
            .prune_to_max(2)
            .unwrap();
        assert_eq!(second.pruned_tasks, 0);
        assert_eq!(second.retained_terminal, 2);

        cleanup(&db_path);
    }

    #[test]
    fn legacy_database_without_child_tables_can_still_be_pruned() {
        let db_path = temp_db("terminal_retention_legacy");
        RobustSinkhornQueue::new(&db_path).ensure_schema().unwrap();
        let conn = Connection::open(&db_path).unwrap();
        insert_task(&conn, 1, "COMPLETED", 1.0);
        insert_task(&conn, 2, "FAILED", 2.0);
        insert_task(&conn, 3, "RUNNING", 0.5);
        drop(conn);

        let result = TerminalRetentionStore::new(&db_path)
            .prune_to_max(1)
            .unwrap();
        assert_eq!(result.pruned_tasks, 1);
        assert_eq!(result.pruned_idempotency, 0);
        assert_eq!(result.pruned_fences, 0);

        let conn = Connection::open(&db_path).unwrap();
        let active_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE status = 'RUNNING'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 1);

        cleanup(&db_path);
    }

    #[test]
    fn rejects_non_positive_retention_bound() {
        let db_path = temp_db("terminal_retention_invalid");
        RobustSinkhornQueue::new(&db_path).ensure_schema().unwrap();
        let store = TerminalRetentionStore::new(&db_path);

        assert!(store.prune_to_max(0).is_err());
        assert!(store.prune_to_max(-1).is_err());

        cleanup(&db_path);
    }
}
