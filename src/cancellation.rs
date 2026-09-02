use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::sync_queue::{DatabaseManager, QueueError, QueueResult};
use crate::value::TaskStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancellationOutcome {
    Applied,
    Replayed,
    NotFound,
    Terminal(TaskStatus),
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

    pub fn cancel_task(&self, task_id: i64) -> QueueResult<CancellationOutcome> {
        if task_id <= 0 {
            return Err(QueueError::InvalidState(
                "task id must be a positive integer".into(),
            ));
        }

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

            let Some((status_text, generation)) = current else {
                tx.commit()?;
                return Ok(CancellationOutcome::NotFound);
            };

            let status = TaskStatus::parse(&status_text)?;
            match status {
                TaskStatus::Cancelled => {
                    tx.commit()?;
                    return Ok(CancellationOutcome::Replayed);
                }
                TaskStatus::Completed | TaskStatus::Failed => {
                    tx.commit()?;
                    return Ok(CancellationOutcome::Terminal(status));
                }
                TaskStatus::Pending | TaskStatus::Assigned | TaskStatus::Running => {}
            }

            let next_generation = generation.checked_add(1).ok_or_else(|| {
                QueueError::InvalidState(format!(
                    "lease generation overflow while cancelling task_id={task_id}"
                ))
            })?;

            tx.execute(
                "INSERT INTO task_lease_fences (task_id, generation)\n                 VALUES (?1, ?2)\n                 ON CONFLICT(task_id) DO UPDATE SET generation = excluded.generation",
                params![task_id, next_generation],
            )?;

            let affected = tx.execute(
                "UPDATE tasks\n                 SET status = 'CANCELLED',\n                     locked_by = NULL,\n                     locked_until = NULL,\n                     heartbeat_at = NULL,\n                     updated_at = ?1\n                 WHERE id = ?2\n                   AND status = ?3",
                params![now, task_id, status.as_str()],
            )?;

            if affected != 1 {
                return Err(QueueError::InvalidState(format!(
                    "cancellation lost selected task state for task_id={task_id}"
                )));
            }

            tx.commit()?;
            Ok(CancellationOutcome::Applied)
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
    use crate::result_projection::TaskResultStore;
    use crate::sync_queue::{RobustSinkhornQueue, WorkerDescriptor};
    use crate::task_query::TaskQueryStore;
    use crate::value::{LeaseMutation, TaskStatus};

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}.db", rand::random::<u64>()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    fn prepare(path: &Path) -> (RobustSinkhornQueue, LeaseFence, CancellationStore) {
        let queue = RobustSinkhornQueue::new(path);
        queue.ensure_schema().unwrap();
        let fence = LeaseFence::new(path);
        fence.ensure_schema().unwrap();
        let cancellation = CancellationStore::new(path);
        (queue, fence, cancellation)
    }

    #[test]
    fn pending_cancellation_is_terminal_and_never_dispatches() {
        let db_path = temp_db("cancel_pending");
        let (queue, _fence, cancellation) = prepare(&db_path);
        let task_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();

        assert_eq!(
            cancellation.cancel_task(task_id).unwrap(),
            CancellationOutcome::Applied
        );

        let dispatched = queue
            .dispatch_batch_defaults(&[WorkerDescriptor {
                worker_id: "workflow-1".into(),
                worker_type: "workflow".into(),
                capacity: 1,
                available_slots: 1,
            }])
            .unwrap();
        assert!(dispatched.is_empty());

        let snapshot = TaskQueryStore::new(&db_path).get_task(task_id).unwrap().unwrap();
        assert_eq!(snapshot.status, TaskStatus::Cancelled.as_str());
        assert_eq!(snapshot.lease_generation, 1);
        assert!(snapshot.locked_by.is_none());

        cleanup(&db_path);
    }

    #[test]
    fn running_cancellation_revokes_the_exact_fence_generation() {
        let db_path = temp_db("cancel_running");
        let (queue, fence, cancellation) = prepare(&db_path);
        let results = TaskResultStore::new(&db_path);
        results.ensure_schema().unwrap();
        let task_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();
        let worker_id = "workflow-1";

        let dispatched = queue
            .dispatch_batch_defaults(&[WorkerDescriptor {
                worker_id: worker_id.into(),
                worker_type: "workflow".into(),
                capacity: 1,
                available_slots: 1,
            }])
            .unwrap();
        assert_eq!(dispatched.len(), 1);
        let claimed = fence.claim_task(worker_id).unwrap().unwrap();
        assert_eq!(claimed.id, task_id);

        assert_eq!(
            cancellation.cancel_task(task_id).unwrap(),
            CancellationOutcome::Applied
        );

        assert_eq!(
            fence
                .heartbeat(task_id, worker_id, claimed.lease_generation, 10.0)
                .unwrap(),
            LeaseMutation::Stale
        );
        assert_eq!(
            fence
                .complete_task(task_id, worker_id, claimed.lease_generation)
                .unwrap(),
            LeaseMutation::Stale
        );
        assert_eq!(
            fence
                .fail_task(task_id, worker_id, claimed.lease_generation, "late failure")
                .unwrap(),
            LeaseMutation::Stale
        );
        assert_eq!(
            results
                .complete_with_projection(
                    task_id,
                    worker_id,
                    claimed.lease_generation,
                    r#"{"must_not":"persist"}"#,
                )
                .unwrap(),
            LeaseMutation::Stale
        );
        assert!(results.get(task_id).unwrap().is_none());

        let snapshot = TaskQueryStore::new(&db_path).get_task(task_id).unwrap().unwrap();
        assert_eq!(snapshot.status, TaskStatus::Cancelled.as_str());
        assert_eq!(
            snapshot.lease_generation,
            claimed.lease_generation.value() + 1
        );
        assert!(snapshot.locked_by.is_none());
        assert!(snapshot.locked_until.is_none());
        assert!(snapshot.heartbeat_at.is_none());

        let generation_after_first_cancel = snapshot.lease_generation;
        assert_eq!(
            cancellation.cancel_task(task_id).unwrap(),
            CancellationOutcome::Replayed
        );
        let replayed = TaskQueryStore::new(&db_path).get_task(task_id).unwrap().unwrap();
        assert_eq!(replayed.lease_generation, generation_after_first_cancel);

        cleanup(&db_path);
    }

    #[test]
    fn completed_task_wins_a_race_against_late_cancellation() {
        let db_path = temp_db("cancel_completed");
        let (queue, fence, cancellation) = prepare(&db_path);
        let task_id = queue.enqueue_simple("workflow.run", "workflow", "{}").unwrap();
        let worker_id = "workflow-1";
        queue
            .dispatch_batch_defaults(&[WorkerDescriptor {
                worker_id: worker_id.into(),
                worker_type: "workflow".into(),
                capacity: 1,
                available_slots: 1,
            }])
            .unwrap();
        let claimed = fence.claim_task(worker_id).unwrap().unwrap();
        assert_eq!(
            fence
                .complete_task(task_id, worker_id, claimed.lease_generation)
                .unwrap(),
            LeaseMutation::Applied
        );

        assert_eq!(
            cancellation.cancel_task(task_id).unwrap(),
            CancellationOutcome::Terminal(TaskStatus::Completed)
        );
        let snapshot = TaskQueryStore::new(&db_path).get_task(task_id).unwrap().unwrap();
        assert_eq!(snapshot.status, TaskStatus::Completed.as_str());
        assert_eq!(snapshot.lease_generation, claimed.lease_generation.value());

        cleanup(&db_path);
    }
}
