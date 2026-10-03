//! Konfigurasi gateway dari environment variables.

pub struct Config {
    pub port: u16,
    pub db_path: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: std::env::var("TQQ_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3100),
            db_path: std::env::var("TQQ_DB")
                .unwrap_or_else(|_| {
                    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                    format!("{}/tqq/queue.db", home)
                }),
        }
    }
}
