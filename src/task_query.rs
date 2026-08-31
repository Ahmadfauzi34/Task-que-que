use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};

use crate::sync_queue::{DatabaseManager, QueueResult};

#[derive(Debug, Clone, PartialEq)]
pub struct TaskSnapshot {
    pub id: i64,
    pub task_name: String,
    pub task_type: String,
    pub priority: i64,
    pub max_retries: i64,
    pub retry_count: i64,
    pub status: String,
    pub locked_by: Option<String>,
    pub locked_until: Option<f64>,
    pub heartbeat_at: Option<f64>,
    pub error_log: Option<String>,
    pub scheduled_at: f64,
    pub created_at: f64,
    pub updated_at: f64,
    pub lease_generation: i64,
}

#[derive(Debug, Clone)]
pub struct TaskQueryStore {
    db_path: PathBuf,
}

impl TaskQueryStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn ping(&self) -> QueueResult<()> {
        DatabaseManager::execute_with_retry(&self.db_path, |conn| {
            conn.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
    }

    pub fn get_task(&self, task_id: i64) -> QueueResult<Option<TaskSnapshot>> {
        DatabaseManager::execute_with_retry(&self.db_path, move |conn| {
            conn.query_row(
                "SELECT
                    t.id,
                    t.task_name,
                    t.task_type,
                    t.priority,
                    t.max_retries,
                    t.retry_count,
                    t.status,
                    t.locked_by,
                    t.locked_until,
                    t.heartbeat_at,
                    t.error_log,
                    t.scheduled_at,
                    t.created_at,
                    t.updated_at,
                    COALESCE(f.generation, 0)
                 FROM tasks AS t
                 LEFT JOIN task_lease_fences AS f ON f.task_id = t.id
                 WHERE t.id = ?1",
                params![task_id],
                |row| {
                    Ok(TaskSnapshot {
                        id: row.get(0)?,
                        task_name: row.get(1)?,
                        task_type: row.get(2)?,
                        priority: row.get(3)?,
                        max_retries: row.get(4)?,
                        retry_count: row.get(5)?,
                        status: row.get(6)?,
                        locked_by: row.get(7)?,
                        locked_until: row.get(8)?,
                        heartbeat_at: row.get(9)?,
                        error_log: row.get(10)?,
                        scheduled_at: row.get(11)?,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                        lease_generation: row.get(14)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
    }
}
