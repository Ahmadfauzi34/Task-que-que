use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};

fn now_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelTaskResult {
    Cancelled {
        previous_status: String,
        lease_generation: i64,
    },
    AlreadyCancelled {
        lease_generation: i64,
    },
    Terminal {
        status: String,
    },
    NotFound,
}

#[derive(Debug, Clone)]
pub struct CancellationStore {
    db_path: PathBuf,
}

impl CancellationStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn cancel_task(&self, task_id: i64) -> QueueResult<CancelTaskResult> {
        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            let now = now_f64();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let current = tx
                .query_row(
                    "SELECT t.status, COALESCE(f.generation, 0)\n                     FROM tasks AS t\n                     LEFT JOIN task_lease_fences AS f ON f.task_id = t.id\n                     WHERE t.id = ?1",
                    params![task_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;

            let Some((status, generation)) = current else {
                tx.commit()?;
                return Ok(CancelTaskResult::NotFound);
            };

            if status == "CANCELLED" {
                tx.commit()?;
                return Ok(CancelTaskResult::AlreadyCancelled {
                    lease_generation: generation,
                });
            }

            if status == "COMPLETED" || status == "FAILED" {
                tx.commit()?;
                return Ok(CancelTaskResult::Terminal { status });
            }

            if status != "PENDING" && status != "ASSIGNED" && status != "RUNNING" {
                return Err(QueueError::InvalidState(format!(
                    "cannot cancel task_id={task_id} from unknown status={status}"
                )));
            }

            let next_generation = generation.checked_add(1).ok_or_else(|| {
                QueueError::InvalidState(format!(
                    "lease generation overflow while cancelling task_id={task_id}"
                ))
            })?;

            let affected = tx.execute(
                "UPDATE tasks\n                 SET status = 'CANCELLED',\n                     locked_by = NULL,\n                     locked_until = NULL,\n                     heartbeat_at = NULL,\n                     updated_at = ?1\n                 WHERE id = ?2\n                   AND status = ?3",
                params![now, task_id, status],
            )?;

            if affected != 1 {
                return Err(QueueError::InvalidState(format!(
                    "cancellation transition lost task_id={task_id}"
                )));
            }

            tx.execute(
                "INSERT INTO task_lease_fences (task_id, generation)\n                 VALUES (?1, ?2)\n                 ON CONFLICT(task_id) DO UPDATE SET generation = excluded.generation",
                params![task_id, next_generation],
            )?;

            tx.commit()?;
            Ok(CancelTaskResult::Cancelled {
                previous_status: status,
                lease_generation: next_generation,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lease_fence::LeaseFence;
    use crate::sync_queue::{RobustSinkhornQueue, WorkerDescriptor};
    use crate::value::LeaseGeneration;

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}.db", rand::random::<u64>()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn pending_cancellation_is_terminal_and_idempotent() {
        let db_path = temp_db("cancel_pending");
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        LeaseFence::new(&db_path).ensure_schema().unwrap();
        let task_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();
        let cancellation = CancellationStore::new(&db_path);

        let first = cancellation.cancel_task(task_id).unwrap();
        assert_eq!(
            first,
            CancelTaskResult::Cancelled {
                previous_status: "PENDING".into(),
                lease_generation: 1,
            }
        );
        assert_eq!(
            cancellation.cancel_task(task_id).unwrap(),
            CancelTaskResult::AlreadyCancelled {
                lease_generation: 1,
            }
        );

        let dispatched = queue
            .dispatch_batch_defaults(&[WorkerDescriptor {
                worker_id: "worker-1".into(),
                worker_type: "workflow".into(),
                capacity: 1,
                available_slots: 1,
            }])
            .unwrap();
        assert!(dispatched.is_empty());

        cleanup(&db_path);
    }

    #[test]
    fn running_cancellation_revokes_existing_generation_and_heartbeat() {
        let db_path = temp_db("cancel_running");
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        let fence = LeaseFence::new(&db_path);
        fence.ensure_schema().unwrap();
        let task_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();
        queue
            .dispatch_batch_defaults(&[WorkerDescriptor {
                worker_id: "worker-1".into(),
                worker_type: "workflow".into(),
                capacity: 1,
                available_slots: 1,
            }])
            .unwrap();
        let claimed = fence.claim_task("worker-1").unwrap().unwrap();
        let generation = claimed.lease_generation;
        assert_eq!(generation.value(), 1);

        let cancelled = CancellationStore::new(&db_path).cancel_task(task_id).unwrap();
        assert_eq!(
            cancelled,
            CancelTaskResult::Cancelled {
                previous_status: "RUNNING".into(),
                lease_generation: 2,
            }
        );

        let heartbeat = fence
            .heartbeat(task_id, "worker-1", generation, 10.0)
            .unwrap();
        assert!(!heartbeat.is_applied());
        let complete = fence
            .complete_task(task_id, "worker-1", LeaseGeneration::new(1))
            .unwrap();
        assert!(!complete.is_applied());

        cleanup(&db_path);
    }

    #[test]
    fn completed_and_failed_tasks_cannot_be_rewritten_as_cancelled() {
        let db_path = temp_db("cancel_terminal");
        let queue = RobustSinkhornQueue::new(&db_path);
        queue.ensure_schema().unwrap();
        LeaseFence::new(&db_path).ensure_schema().unwrap();
        let completed_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();
        let failed_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();

        DatabaseManager::execute_with_retry(&db_path, |conn| {
            conn.execute(
                "UPDATE tasks SET status = 'COMPLETED' WHERE id = ?1",
                params![completed_id],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'FAILED' WHERE id = ?1",
                params![failed_id],
            )?;
            Ok(())
        })
        .unwrap();

        let cancellation = CancellationStore::new(&db_path);
        assert_eq!(
            cancellation.cancel_task(completed_id).unwrap(),
            CancelTaskResult::Terminal {
                status: "COMPLETED".into(),
            }
        );
        assert_eq!(
            cancellation.cancel_task(failed_id).unwrap(),
            CancelTaskResult::Terminal {
                status: "FAILED".into(),
            }
        );

        cleanup(&db_path);
    }
}
