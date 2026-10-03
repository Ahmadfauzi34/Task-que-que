//! Database SQLite untuk task queue.

use rusqlite::{Connection, Result};

pub fn open(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    Ok(conn)
}

/// Auto-release task CLAIMED yang lease-nya expired.
/// Mengembalikan jumlah task yang di-release.
pub fn auto_release_expired(conn: &Connection) -> Result<usize> {
    let now = chrono::Utc::now().timestamp() as f64;
    let changes = conn.execute(
        "UPDATE tasks SET status = 'PENDING', locked_by = NULL, locked_until = NULL
         WHERE status = 'CLAIMED' AND locked_until IS NOT NULL AND locked_until < ?",
        [now],
    )?;
    Ok(changes)
}
