use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::models::{FileEvent, Operation};

pub struct Journal {
    connection: Connection,
}

impl Journal {
    pub fn open(path: &Path) -> Result<Self> {
        let connection =
            Connection::open(path).with_context(|| format!("open journal {}", path.display()))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
             INSERT OR IGNORE INTO state (key, value) VALUES ('next_sequence', 1);
             CREATE TABLE IF NOT EXISTS events (
               sequence INTEGER PRIMARY KEY,
               event_id TEXT NOT NULL UNIQUE,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS current_files (
               root_id TEXT NOT NULL,
               stable_file_id TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               PRIMARY KEY (root_id, stable_file_id),
               UNIQUE (root_id, relative_path)
             );
             CREATE TABLE IF NOT EXISTS command_executions (
               command_id TEXT PRIMARY KEY,
               outcome TEXT NOT NULL DEFAULT 'CLAIMED',
               completed_at TEXT
             );",
        )?;
        Ok(Self { connection })
    }

    pub fn append(&mut self, mut event: FileEvent) -> Result<u64> {
        let transaction = self.connection.transaction()?;
        let sequence: u64 = transaction.query_row(
            "SELECT value FROM state WHERE key = 'next_sequence'",
            [],
            |row| row.get(0),
        )?;
        event.sequence = sequence;
        let payload = serde_json::to_string(&event)?;
        transaction.execute(
            "INSERT INTO events (sequence, event_id, payload) VALUES (?1, ?2, ?3)",
            params![sequence, event.event_id.to_string(), payload],
        )?;
        match event.operation {
            Operation::Upsert => {
                transaction.execute(
                    "INSERT INTO current_files (root_id, stable_file_id, relative_path) VALUES (?1, ?2, ?3)
                     ON CONFLICT (root_id, stable_file_id) DO UPDATE SET relative_path = excluded.relative_path",
                    params![event.root_id.to_string(), event.stable_file_id, event.relative_path],
                )?;
            }
            Operation::Delete => {
                transaction.execute(
                    "DELETE FROM current_files WHERE root_id = ?1 AND stable_file_id = ?2",
                    params![event.root_id.to_string(), event.stable_file_id],
                )?;
            }
        }
        transaction.execute(
            "UPDATE state SET value = ?1 WHERE key = 'next_sequence'",
            [sequence + 1],
        )?;
        transaction.commit()?;
        Ok(sequence)
    }

    pub fn pending(&self, limit: usize) -> Result<Vec<FileEvent>> {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM events ORDER BY sequence LIMIT ?1")?;
        let rows = statement.query_map([limit], |row| row.get::<_, String>(0))?;
        rows.map(|row| serde_json::from_str(&row?).context("decode journal event"))
            .collect()
    }

    pub fn acknowledge(&self, sequence: u64) -> Result<usize> {
        Ok(self
            .connection
            .execute("DELETE FROM events WHERE sequence <= ?1", [sequence])?)
    }

    pub fn pending_count(&self) -> Result<u64> {
        Ok(self
            .connection
            .query_row("SELECT count(*) FROM events", [], |row| row.get(0))?)
    }

    pub fn path_for_file(&self, root_id: Uuid, stable_file_id: &str) -> Result<Option<String>> {
        self.connection
            .query_row(
                "SELECT relative_path FROM current_files WHERE root_id = ?1 AND stable_file_id = ?2",
                params![root_id.to_string(), stable_file_id],
                |row| row.get(0),
            )
            .optional()
            .context("resolve journal file path")
    }

    pub fn file_for_path(
        &self,
        root_id: Uuid,
        relative_path: &str,
    ) -> Result<Option<(String, String)>> {
        self.connection
            .query_row(
                "SELECT stable_file_id, relative_path FROM current_files WHERE root_id = ?1 AND relative_path = ?2",
                params![root_id.to_string(), relative_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("resolve journal path")
    }

    pub fn claim_command(&self, command_id: Uuid) -> Result<bool> {
        Ok(self.connection.execute(
            "INSERT OR IGNORE INTO command_executions (command_id) VALUES (?1)",
            [command_id.to_string()],
        )? == 1)
    }

    pub fn complete_command(&self, command_id: Uuid, outcome: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE command_executions SET outcome = ?2, completed_at = CURRENT_TIMESTAMP WHERE command_id = ?1",
            params![command_id.to_string(), outcome],
        )?;
        Ok(())
    }
}

pub fn deletion_event(
    root_id: Uuid,
    stable_file_id: String,
    name: String,
    relative_path: String,
) -> FileEvent {
    FileEvent {
        event_id: Uuid::new_v4(),
        sequence: 0,
        operation: Operation::Delete,
        root_id,
        stable_file_id,
        name,
        relative_path,
        extension: String::new(),
        size_bytes: 0,
        modified_at: chrono::Utc::now(),
    }
}
